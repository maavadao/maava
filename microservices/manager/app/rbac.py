"""RBAC: permission catalog, built-in roles, and per-request resolution.

Resolution (additive grants, most-specific wins, no deny):

    perms = platform_admin_bypass(user)
          | org_role_perms(user, org)
          | instance_role_perms(user, instance)
    if api_key: perms &= api_key.permissions   # keys can only narrow
"""

import uuid
from dataclasses import dataclass, field

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .db import get_db
from .models import ApiKey, Instance, InstanceRoleBinding, OrgMembership, Role, User

# --- permission catalog --------------------------------------------
ORG_PERMISSIONS = [
    "org:read", "org:update", "org:delete",
    "org:members:read", "org:members:manage",
    "org:roles:read", "org:roles:manage",
    "org:apikeys:read", "org:apikeys:manage",
    "org:billing:read", "org:billing:manage",
    "org:audit:read",
]
INSTANCE_PERMISSIONS = [
    "instance:create", "instance:read", "instance:update", "instance:delete",
    "instance:lifecycle",
    "instance:config:read", "instance:config:write",
    "instance:secrets:manage",
    "instance:models:read", "instance:models:write",
    "instance:channels:read", "instance:channels:write",
    "instance:skills:read", "instance:skills:write",
    "instance:tools:read", "instance:tools:write",
    "instance:sessions:read", "instance:sessions:delete",
    "instance:logs:read",
    "instance:console",
]
ALL_PERMISSIONS = ORG_PERMISSIONS + INSTANCE_PERMISSIONS

# --- built-in roles (see design doc §3.3) ---------------------------
_VIEWER = {
    "org:read",
    "instance:read", "instance:config:read",
    "instance:models:read", "instance:channels:read",
    "instance:skills:read", "instance:tools:read",
    "instance:sessions:read", "instance:logs:read",
}
_DEVELOPER = _VIEWER | {
    "instance:models:write", "instance:skills:write",
    "instance:tools:write", "instance:console",
}
_OPERATOR = _DEVELOPER | {
    "instance:update", "instance:lifecycle",
    "instance:config:write", "instance:channels:write",
    "instance:sessions:delete",
}
_ADMIN = _OPERATOR | {
    "instance:create", "instance:delete", "instance:secrets:manage",
    "org:update",
    "org:members:read", "org:members:manage",
    "org:roles:read", "org:roles:manage",
    "org:apikeys:read", "org:apikeys:manage",
    "org:audit:read",
}
_OWNER = _ADMIN | {"org:delete", "org:billing:read", "org:billing:manage"}
_BILLING = {"org:read", "org:billing:read", "org:billing:manage"}

BUILTIN_ROLES: dict[str, set[str]] = {
    "owner": _OWNER,
    "admin": _ADMIN,
    "operator": _OPERATOR,
    "developer": _DEVELOPER,
    "viewer": _VIEWER,
    "billing": _BILLING,
}


# --- principal ------------------------------------------------------
@dataclass
class Principal:
    user: User | None = None
    api_key: ApiKey | None = None

    @property
    def actor_label(self) -> str:
        if self.api_key is not None:
            return f"api_key:{self.api_key.key_prefix}"
        return f"user:{self.user.email}" if self.user else "anonymous"


@dataclass
class AuthContext:
    """Resolved authorization context, attached to request.state for auditing."""

    principal: Principal
    org_id: uuid.UUID | None = None
    instance: Instance | None = None
    permissions: set[str] = field(default_factory=set)


def _role_perms(role: Role) -> set[str]:
    return set(role.permission_ids)


def resolve_permissions(
    db: Session,
    principal: Principal,
    org_id: uuid.UUID | None,
    instance: Instance | None = None,
) -> set[str]:
    user = principal.user
    perms: set[str] = set()

    if user is not None and user.is_platform_admin:
        perms = set(ALL_PERMISSIONS)
    elif user is not None and org_id is not None:
        membership = db.get(
            OrgMembership,
            (org_id, user.id),
            options=[selectinload(OrgMembership.role).selectinload(Role.permissions)],
        )
        if membership:
            perms |= _role_perms(membership.role)
        if instance is not None:
            binding = db.get(
                InstanceRoleBinding,
                (instance.id, user.id),
                options=[selectinload(InstanceRoleBinding.role).selectinload(Role.permissions)],
            )
            if binding:
                perms |= _role_perms(binding.role)

    if principal.api_key is not None:
        key = principal.api_key
        if key.org_id != org_id:
            return set()
        if instance is not None and key.instance_ids and str(instance.id) not in key.instance_ids:
            return set()
        creator = db.get(User, key.created_by)
        creator_perms = resolve_permissions(db, Principal(user=creator), org_id, instance)
        perms = set(key.permissions) & creator_perms

    return perms


# --- FastAPI dependencies ------------------------------------------
def get_principal(request: Request, db: Session = Depends(get_db)) -> Principal:
    from .security import decode_access_token, sha256, API_KEY_PREFIX
    from .models import now

    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, detail={"code": "unauthorized", "message": "missing bearer token"})
    token = auth[len("Bearer "):].strip()

    if token.startswith(API_KEY_PREFIX):
        key = db.scalar(select(ApiKey).where(ApiKey.key_hash == sha256(token)))
        if key is None or key.revoked_at is not None:
            raise HTTPException(401, detail={"code": "unauthorized", "message": "invalid api key"})
        if key.expires_at is not None and key.expires_at.replace(tzinfo=None) < now().replace(tzinfo=None):
            raise HTTPException(401, detail={"code": "unauthorized", "message": "api key expired"})
        key.last_used_at = now()
        db.commit()
        creator = db.get(User, key.created_by)
        return Principal(user=creator, api_key=key)

    user_id = decode_access_token(token)
    if user_id is None:
        raise HTTPException(401, detail={"code": "unauthorized", "message": "invalid or expired token"})
    user = db.get(User, user_id)
    if user is None or user.status != "active" or user.deleted_at is not None:
        raise HTTPException(401, detail={"code": "unauthorized", "message": "user not active"})
    return Principal(user=user)


def _load_scope(
    request: Request, db: Session, principal: Principal
) -> tuple[uuid.UUID | None, Instance | None]:
    """Derive org/instance scope from path params."""
    params = request.path_params
    instance = None
    org_id: uuid.UUID | None = None

    if "instance_id" in params:
        try:
            iid = uuid.UUID(str(params["instance_id"]))
        except ValueError:
            raise HTTPException(404, detail={"code": "not_found", "message": "instance not found"})
        instance = db.get(Instance, iid)
        if instance is None or instance.deleted_at is not None:
            raise HTTPException(404, detail={"code": "not_found", "message": "instance not found"})
        org_id = instance.org_id
    elif "org_id" in params:
        try:
            org_id = uuid.UUID(str(params["org_id"]))
        except ValueError:
            raise HTTPException(404, detail={"code": "not_found", "message": "org not found"})
    return org_id, instance


def require(permission: str):
    """Dependency factory: authenticate, resolve scope from the path, check one permission."""

    if permission not in ALL_PERMISSIONS:
        raise ValueError(f"unknown permission: {permission}")

    def dependency(
        request: Request,
        principal: Principal = Depends(get_principal),
        db: Session = Depends(get_db),
    ) -> AuthContext:
        org_id, instance = _load_scope(request, db, principal)
        perms = resolve_permissions(db, principal, org_id, instance)
        ctx = AuthContext(principal=principal, org_id=org_id, instance=instance, permissions=perms)
        request.state.auth = ctx
        if permission not in perms:
            request.state.audit_result = "denied"
            raise HTTPException(
                403,
                detail={"code": "forbidden", "message": f"missing permission {permission}"},
            )
        return ctx

    return dependency
