import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..audit import set_action
from ..db import get_db
from ..models import ApiKey, Instance, now
from ..rbac import AuthContext, require, resolve_permissions
from ..schemas import ApiKeyCreate, ApiKeyCreated, ApiKeyOut, ListResponse, StatusOk
from ..security import new_api_key

router = APIRouter(prefix="/v1/orgs/{org_id}/api-keys", tags=["api-keys"])


@router.get("", response_model=ListResponse)
def list_api_keys(
    org_id: uuid.UUID,
    ctx: AuthContext = Depends(require("org:apikeys:read")),
    db: Session = Depends(get_db),
):
    keys = db.scalars(
        select(ApiKey).where(ApiKey.org_id == org_id, ApiKey.revoked_at.is_(None))
    ).all()
    return ListResponse(data=[ApiKeyOut.model_validate(k) for k in keys])


@router.post("", response_model=ApiKeyCreated, status_code=201)
def create_api_key(
    org_id: uuid.UUID,
    body: ApiKeyCreate,
    request: Request,
    ctx: AuthContext = Depends(require("org:apikeys:manage")),
    db: Session = Depends(get_db),
):
    if ctx.principal.api_key is not None:
        raise HTTPException(403, detail={"code": "forbidden", "message": "api keys cannot mint api keys"})

    # A key can never carry more than its creator's current permissions.
    creator_perms = resolve_permissions(db, ctx.principal, org_id)
    excess = sorted(set(body.permissions) - creator_perms)
    if excess:
        raise HTTPException(
            400,
            detail={"code": "invalid_permissions", "message": f"exceeds your grants: {', '.join(excess)}"},
        )

    instance_ids = None
    if body.instance_ids is not None:
        for iid in body.instance_ids:
            inst = db.get(Instance, iid)
            if inst is None or inst.org_id != org_id or inst.deleted_at is not None:
                raise HTTPException(
                    400, detail={"code": "invalid_instance", "message": f"instance {iid} not in org"}
                )
        instance_ids = [str(i) for i in body.instance_ids]

    secret, prefix, key_hash = new_api_key()
    key = ApiKey(
        org_id=org_id,
        name=body.name,
        key_prefix=prefix,
        key_hash=key_hash,
        permissions=sorted(set(body.permissions)),
        instance_ids=instance_ids,
        created_by=ctx.principal.user.id,
        expires_at=body.expires_at,
    )
    db.add(key)
    db.commit()
    set_action(request, "org.apikey.create", body.name)
    return ApiKeyCreated(
        id=key.id,
        name=key.name,
        key_prefix=key.key_prefix,
        permissions=key.permissions,
        instance_ids=key.instance_ids,
        expires_at=key.expires_at,
        last_used_at=key.last_used_at,
        created_at=key.created_at,
        secret=secret,
    )


@router.delete("/{key_id}", response_model=StatusOk)
def revoke_api_key(
    org_id: uuid.UUID,
    key_id: uuid.UUID,
    request: Request,
    ctx: AuthContext = Depends(require("org:apikeys:manage")),
    db: Session = Depends(get_db),
):
    key = db.get(ApiKey, key_id)
    if key is None or key.org_id != org_id or key.revoked_at is not None:
        raise HTTPException(404, detail={"code": "not_found", "message": "api key not found"})
    key.revoked_at = now()
    db.commit()
    set_action(request, "org.apikey.revoke", key.name)
    return StatusOk()
