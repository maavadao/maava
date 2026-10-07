import re
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..config import settings
from ..db import get_db
from ..models import Organization, OrgMembership, RefreshToken, Role, User, now
from ..rbac import Principal, get_principal
from ..schemas import (
    LoginRequest,
    MeResponse,
    MembershipOut,
    RefreshRequest,
    RegisterRequest,
    StatusOk,
    TokenResponse,
    UpdateMeRequest,
    UserOut,
)
from ..security import (
    create_access_token,
    hash_password,
    new_opaque_token,
    sha256,
    verify_password,
)

router = APIRouter(prefix="/v1", tags=["auth"])


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9-]", "-", name.lower()).strip("-")
    return re.sub(r"-{2,}", "-", slug)[:63] or "org"


def _system_role(db: Session, name: str) -> Role:
    role = db.scalar(select(Role).where(Role.is_system.is_(True), Role.name == name))
    if role is None:
        raise HTTPException(500, detail={"code": "internal", "message": f"system role {name} missing"})
    return role


def _issue_tokens(db: Session, user: User, request: Request) -> TokenResponse:
    secret, token_hash = new_opaque_token()
    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=token_hash,
            expires_at=now() + timedelta(days=settings.refresh_token_days),
            user_agent=request.headers.get("user-agent", ""),
            ip=request.client.host if request.client else None,
        )
    )
    db.commit()
    return TokenResponse(
        access_token=create_access_token(user.id),
        refresh_token=secret,
        expires_in=settings.access_token_minutes * 60,
    )


@router.post("/auth/register", response_model=TokenResponse, status_code=201)
def register(body: RegisterRequest, request: Request, db: Session = Depends(get_db)):
    email = body.email.lower()
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(409, detail={"code": "conflict", "message": "email already registered"})

    user = User(email=email, password_hash=hash_password(body.password), display_name=body.display_name)
    db.add(user)
    db.flush()

    if body.org_name:
        base = _slugify(body.org_name)
        slug, i = base, 1
        while db.scalar(select(Organization).where(Organization.slug == slug)):
            i += 1
            slug = f"{base}-{i}"
        org = Organization(name=body.org_name, slug=slug)
        db.add(org)
        db.flush()
        db.add(OrgMembership(org_id=org.id, user_id=user.id, role_id=_system_role(db, "owner").id))

    db.commit()
    return _issue_tokens(db, user, request)


@router.post("/auth/login", response_model=TokenResponse)
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    if (
        user is None
        or user.password_hash is None
        or not verify_password(body.password, user.password_hash)
    ):
        raise HTTPException(401, detail={"code": "unauthorized", "message": "invalid credentials"})
    if user.status != "active" or user.deleted_at is not None:
        raise HTTPException(403, detail={"code": "forbidden", "message": "account disabled"})
    return _issue_tokens(db, user, request)


@router.post("/auth/refresh", response_model=TokenResponse)
def refresh(body: RefreshRequest, request: Request, db: Session = Depends(get_db)):
    token = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == sha256(body.refresh_token)))
    if (
        token is None
        or token.revoked_at is not None
        or token.expires_at.replace(tzinfo=None) < now().replace(tzinfo=None)
    ):
        raise HTTPException(401, detail={"code": "unauthorized", "message": "invalid refresh token"})
    user = db.get(User, token.user_id)
    if user is None or user.status != "active":
        raise HTTPException(401, detail={"code": "unauthorized", "message": "user not active"})
    token.revoked_at = now()  # rotate
    db.commit()
    return _issue_tokens(db, user, request)


@router.post("/auth/logout", response_model=StatusOk)
def logout(body: RefreshRequest, db: Session = Depends(get_db)):
    token = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == sha256(body.refresh_token)))
    if token and token.revoked_at is None:
        token.revoked_at = now()
        db.commit()
    return StatusOk()


@router.get("/me", response_model=MeResponse)
def me(principal: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    user = principal.user
    memberships = db.scalars(
        select(OrgMembership)
        .where(OrgMembership.user_id == user.id)
        .options(selectinload(OrgMembership.org), selectinload(OrgMembership.role))
    ).all()
    return MeResponse(
        user=UserOut.model_validate(user),
        memberships=[
            MembershipOut(
                org_id=m.org_id, org_slug=m.org.slug, org_name=m.org.name, role=m.role.name
            )
            for m in memberships
            if m.org.deleted_at is None
        ],
    )


@router.patch("/me", response_model=UserOut)
def update_me(
    body: UpdateMeRequest,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    user = principal.user
    if principal.api_key is not None:
        raise HTTPException(403, detail={"code": "forbidden", "message": "api keys cannot edit profiles"})
    if body.display_name is not None:
        user.display_name = body.display_name
    if body.new_password is not None:
        if not body.current_password or not verify_password(
            body.current_password, user.password_hash or ""
        ):
            raise HTTPException(
                400, detail={"code": "invalid_password", "message": "current password incorrect"}
            )
        user.password_hash = hash_password(body.new_password)
    db.commit()
    return UserOut.model_validate(user)
