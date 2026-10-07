import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from ..audit import set_action
from ..db import get_db
from ..models import InstanceRoleBinding, OrgMembership, Role, RolePermission
from ..rbac import ALL_PERMISSIONS, AuthContext, require
from ..schemas import ListResponse, RoleCreate, RoleOut, RoleUpdate, StatusOk

router = APIRouter(prefix="/v1/orgs/{org_id}/roles", tags=["roles"])


def _validate_permissions(perms: list[str]) -> list[str]:
    unknown = sorted(set(perms) - set(ALL_PERMISSIONS))
    if unknown:
        raise HTTPException(
            400, detail={"code": "invalid_permissions", "message": f"unknown: {', '.join(unknown)}"}
        )
    return sorted(set(perms))


def _role_out(role: Role) -> RoleOut:
    return RoleOut(
        id=role.id,
        name=role.name,
        description=role.description,
        is_system=role.is_system,
        permissions=sorted(role.permission_ids),
    )


@router.get("", response_model=ListResponse)
def list_roles(
    org_id: uuid.UUID,
    ctx: AuthContext = Depends(require("org:roles:read")),
    db: Session = Depends(get_db),
):
    roles = db.scalars(
        select(Role)
        .where((Role.is_system.is_(True)) | (Role.org_id == org_id))
        .options(selectinload(Role.permissions))
        .order_by(Role.is_system.desc(), Role.name)
    ).all()
    return ListResponse(data=[_role_out(r) for r in roles])


@router.post("", response_model=RoleOut, status_code=201)
def create_role(
    org_id: uuid.UUID,
    body: RoleCreate,
    request: Request,
    ctx: AuthContext = Depends(require("org:roles:manage")),
    db: Session = Depends(get_db),
):
    perms = _validate_permissions(body.permissions)
    clash = db.scalar(
        select(Role).where(
            ((Role.org_id == org_id) | (Role.is_system.is_(True))), Role.name == body.name
        )
    )
    if clash:
        raise HTTPException(409, detail={"code": "conflict", "message": "role name already exists"})
    role = Role(org_id=org_id, name=body.name, description=body.description)
    role.permissions = [RolePermission(permission_id=p) for p in perms]
    db.add(role)
    db.commit()
    set_action(request, "org.role.create", body.name)
    return _role_out(role)


@router.patch("/{role_id}", response_model=RoleOut)
def update_role(
    org_id: uuid.UUID,
    role_id: uuid.UUID,
    body: RoleUpdate,
    request: Request,
    ctx: AuthContext = Depends(require("org:roles:manage")),
    db: Session = Depends(get_db),
):
    role = db.get(Role, role_id, options=[selectinload(Role.permissions)])
    if role is None or role.org_id != org_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "role not found"})
    if role.is_system:
        raise HTTPException(400, detail={"code": "immutable", "message": "built-in roles are immutable"})
    if body.description is not None:
        role.description = body.description
    if body.permissions is not None:
        perms = _validate_permissions(body.permissions)
        role.permissions = [RolePermission(permission_id=p) for p in perms]
    db.commit()
    set_action(request, "org.role.update", role.name)
    return _role_out(role)


@router.delete("/{role_id}", response_model=StatusOk)
def delete_role(
    org_id: uuid.UUID,
    role_id: uuid.UUID,
    request: Request,
    ctx: AuthContext = Depends(require("org:roles:manage")),
    db: Session = Depends(get_db),
):
    role = db.get(Role, role_id)
    if role is None or role.org_id != org_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "role not found"})
    if role.is_system:
        raise HTTPException(400, detail={"code": "immutable", "message": "built-in roles are immutable"})
    bound = db.scalar(
        select(func.count()).select_from(OrgMembership).where(OrgMembership.role_id == role_id)
    ) + db.scalar(
        select(func.count())
        .select_from(InstanceRoleBinding)
        .where(InstanceRoleBinding.role_id == role_id)
    )
    if bound:
        raise HTTPException(
            409, detail={"code": "conflict", "message": f"role is bound to {bound} principal(s)"}
        )
    db.delete(role)
    db.commit()
    set_action(request, "org.role.delete", role.name)
    return StatusOk()
