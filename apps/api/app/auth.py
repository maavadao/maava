"""JWT authentication (Phase 0: HS256 dev tokens; swap for IdP JWKS later).

Claims: sub = user_id, org_id = active org (absent during signup), role = org_role.
"""
from dataclasses import dataclass
from uuid import UUID

import jwt
from fastapi import Depends, HTTPException, Request

from .config import get_settings


@dataclass(frozen=True)
class TenantContext:
    user_id: UUID
    org_id: UUID | None
    role: str | None


def get_tenant(request: Request) -> TenantContext:
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    s = get_settings()
    try:
        claims = jwt.decode(auth[7:], s.jwt_secret, algorithms=[s.jwt_algorithm])
    except jwt.InvalidTokenError as err:
        raise HTTPException(status_code=401, detail="invalid token") from err
    try:
        user_id = UUID(claims["sub"])
        org_id = UUID(claims["org_id"]) if claims.get("org_id") else None
    except (KeyError, ValueError) as err:
        raise HTTPException(status_code=401, detail="malformed claims") from err
    return TenantContext(user_id=user_id, org_id=org_id, role=claims.get("role"))


def require_org(ctx: TenantContext = Depends(get_tenant)) -> TenantContext:
    if ctx.org_id is None:
        raise HTTPException(status_code=403, detail="no active org")
    return ctx
