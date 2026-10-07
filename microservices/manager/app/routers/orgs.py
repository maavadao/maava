import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from ..audit import set_action
from ..config import settings
from ..db import get_db
from ..models import (
    AuditLog,
    Instance,
    Invitation,
    Organization,
    OrgMembership,
    Role,
    User,
    now,
)
from ..rbac import AuthContext, Principal, get_principal, require
from ..schemas import (
    AuditLogOut,
    InvitationAccept,
    InvitationCreate,
    InvitationCreated,
    InvitationOut,
    ListResponse,
    MemberOut,
    MemberUpdate,
    OrgCreate,
    OrgOut,
    OrgUpdate,
    StatusOk,
)
from ..security import new_opaque_token, sha256

router = APIRouter(prefix="/v1", tags=["orgs"])


def resolve_role(db: Session, org_id: uuid.UUID, name: str) -> Role:
    """Look up a role by name: org-custom first, then built-in."""
    role = db.scalar(select(Role).where(Role.org_id == org_id, Role.name == name))
    if role is None:
        role = db.scalar(select(Role).where(Role.is_system.is_(True), Role.name == name))
    if role is None:
        raise HTTPException(400, detail={"code": "invalid_role", "message": f"unknown role {name}"})
    return role


def _owner_count(db: Session, org_id: uuid.UUID) -> int:
    owner = db.scalar(select(Role).where(Role.is_system.is_(True), Role.name == "owner"))
    return db.scalar(
        select(func.count())
        .select_from(OrgMembership)
        .where(OrgMembership.org_id == org_id, OrgMembership.role_id == owner.id)
    )


@router.post("/orgs", response_model=OrgOut, status_code=201)
def create_org(
    body: OrgCreate,
    request: Request,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    if principal.api_key is not None:
        raise HTTPException(403, detail={"code": "forbidden", "message": "api keys cannot create orgs"})
    if db.scalar(select(Organization).where(Organization.slug == body.slug)):
        raise HTTPException(409, detail={"code": "conflict", "message": "slug already taken"})
    org = Organization(name=body.name, slug=body.slug)
    db.add(org)
    db.flush()
    owner = db.scalar(select(Role).where(Role.is_system.is_(True), Role.name == "owner"))
    db.add(OrgMembership(org_id=org.id, user_id=principal.user.id, role_id=owner.id))
    db.commit()
    set_action(request, "org.create", str(org.id))
    return OrgOut.model_validate(org)


@router.get("/orgs", response_model=ListResponse)
def list_my_orgs(principal: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    memberships = db.scalars(
        select(OrgMembership)
        .where(OrgMembership.user_id == principal.user.id)
        .options(selectinload(OrgMembership.org))
    ).all()
    orgs = [OrgOut.model_validate(m.org) for m in memberships if m.org.deleted_at is None]
    return ListResponse(data=orgs)


@router.get("/orgs/{org_id}", response_model=OrgOut)
def get_org(org_id: uuid.UUID, ctx: AuthContext = Depends(require("org:read")), db: Session = Depends(get_db)):
    org = db.get(Organization, org_id)
    if org is None or org.deleted_at is not None:
        raise HTTPException(404, detail={"code": "not_found", "message": "org not found"})
    return OrgOut.model_validate(org)


@router.patch("/orgs/{org_id}", response_model=OrgOut)
def update_org(
    org_id: uuid.UUID,
    body: OrgUpdate,
    request: Request,
    ctx: AuthContext = Depends(require("org:update")),
    db: Session = Depends(get_db),
):
    org = db.get(Organization, org_id)
    if org is None or org.deleted_at is not None:
        raise HTTPException(404, detail={"code": "not_found", "message": "org not found"})
    if body.name is not None:
        org.name = body.name
    db.commit()
    set_action(request, "org.update", str(org.id))
    return OrgOut.model_validate(org)


@router.delete("/orgs/{org_id}", response_model=StatusOk)
def delete_org(
    org_id: uuid.UUID,
    request: Request,
    ctx: AuthContext = Depends(require("org:delete")),
    db: Session = Depends(get_db),
):
    org = db.get(Organization, org_id)
    if org is None or org.deleted_at is not None:
        raise HTTPException(404, detail={"code": "not_found", "message": "org not found"})
    live = db.scalar(
        select(func.count())
        .select_from(Instance)
        .where(Instance.org_id == org_id, Instance.deleted_at.is_(None))
    )
    if live:
        raise HTTPException(
            409, detail={"code": "conflict", "message": f"{live} instance(s) must be deleted first"}
        )
    org.deleted_at = now()
    org.status = "deleting"
    db.commit()
    set_action(request, "org.delete", str(org.id))
    return StatusOk()


# --- members --------------------------------------------------------
@router.get("/orgs/{org_id}/members", response_model=ListResponse)
def list_members(
    org_id: uuid.UUID,
    ctx: AuthContext = Depends(require("org:members:read")),
    db: Session = Depends(get_db),
):
    memberships = db.scalars(
        select(OrgMembership)
        .where(OrgMembership.org_id == org_id)
        .options(selectinload(OrgMembership.user), selectinload(OrgMembership.role))
    ).all()
    return ListResponse(
        data=[
            MemberOut(
                user_id=m.user_id,
                email=m.user.email,
                display_name=m.user.display_name,
                role=m.role.name,
                joined_at=m.created_at,
            )
            for m in memberships
        ]
    )


@router.patch("/orgs/{org_id}/members/{user_id}", response_model=StatusOk)
def update_member(
    org_id: uuid.UUID,
    user_id: uuid.UUID,
    body: MemberUpdate,
    request: Request,
    ctx: AuthContext = Depends(require("org:members:manage")),
    db: Session = Depends(get_db),
):
    membership = db.get(OrgMembership, (org_id, user_id), options=[selectinload(OrgMembership.role)])
    if membership is None:
        raise HTTPException(404, detail={"code": "not_found", "message": "member not found"})
    new_role = resolve_role(db, org_id, body.role)
    if membership.role.name == "owner" and new_role.name != "owner" and _owner_count(db, org_id) <= 1:
        raise HTTPException(409, detail={"code": "conflict", "message": "cannot demote the last owner"})
    membership.role_id = new_role.id
    db.commit()
    set_action(request, "org.member.update", str(user_id))
    return StatusOk()


@router.delete("/orgs/{org_id}/members/{user_id}", response_model=StatusOk)
def remove_member(
    org_id: uuid.UUID,
    user_id: uuid.UUID,
    request: Request,
    ctx: AuthContext = Depends(require("org:members:manage")),
    db: Session = Depends(get_db),
):
    membership = db.get(OrgMembership, (org_id, user_id), options=[selectinload(OrgMembership.role)])
    if membership is None:
        raise HTTPException(404, detail={"code": "not_found", "message": "member not found"})
    if membership.role.name == "owner" and _owner_count(db, org_id) <= 1:
        raise HTTPException(409, detail={"code": "conflict", "message": "cannot remove the last owner"})
    db.delete(membership)
    db.commit()
    set_action(request, "org.member.remove", str(user_id))
    return StatusOk()


# --- invitations ----------------------------------------------------
@router.post("/orgs/{org_id}/invitations", response_model=InvitationCreated, status_code=201)
def create_invitation(
    org_id: uuid.UUID,
    body: InvitationCreate,
    request: Request,
    ctx: AuthContext = Depends(require("org:members:manage")),
    db: Session = Depends(get_db),
):
    email = body.email.lower()
    existing_user = db.scalar(select(User).where(User.email == email))
    if existing_user and db.get(OrgMembership, (org_id, existing_user.id)):
        raise HTTPException(409, detail={"code": "conflict", "message": "already a member"})
    if db.scalar(
        select(Invitation).where(
            Invitation.org_id == org_id, Invitation.email == email, Invitation.accepted_at.is_(None)
        )
    ):
        raise HTTPException(409, detail={"code": "conflict", "message": "invitation already pending"})

    role = resolve_role(db, org_id, body.role)
    secret, token_hash = new_opaque_token()
    inv = Invitation(
        org_id=org_id,
        email=email,
        role_id=role.id,
        token_hash=token_hash,
        invited_by=ctx.principal.user.id,
        expires_at=now() + timedelta(days=settings.invitation_ttl_days),
    )
    db.add(inv)
    db.commit()
    set_action(request, "org.invitation.create", email)
    return InvitationCreated(
        id=inv.id,
        email=inv.email,
        expires_at=inv.expires_at,
        accepted_at=inv.accepted_at,
        created_at=inv.created_at,
        token=secret,
    )


@router.get("/orgs/{org_id}/invitations", response_model=ListResponse)
def list_invitations(
    org_id: uuid.UUID,
    ctx: AuthContext = Depends(require("org:members:manage")),
    db: Session = Depends(get_db),
):
    invs = db.scalars(
        select(Invitation).where(Invitation.org_id == org_id, Invitation.accepted_at.is_(None))
    ).all()
    return ListResponse(data=[InvitationOut.model_validate(i) for i in invs])


@router.delete("/orgs/{org_id}/invitations/{invitation_id}", response_model=StatusOk)
def revoke_invitation(
    org_id: uuid.UUID,
    invitation_id: uuid.UUID,
    request: Request,
    ctx: AuthContext = Depends(require("org:members:manage")),
    db: Session = Depends(get_db),
):
    inv = db.get(Invitation, invitation_id)
    if inv is None or inv.org_id != org_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "invitation not found"})
    db.delete(inv)
    db.commit()
    set_action(request, "org.invitation.revoke", str(invitation_id))
    return StatusOk()


@router.post("/invitations/accept", response_model=StatusOk)
def accept_invitation(
    body: InvitationAccept,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    inv = db.scalar(select(Invitation).where(Invitation.token_hash == sha256(body.token)))
    if (
        inv is None
        or inv.accepted_at is not None
        or inv.expires_at.replace(tzinfo=None) < now().replace(tzinfo=None)
    ):
        raise HTTPException(400, detail={"code": "invalid_invitation", "message": "invalid or expired"})
    user = principal.user
    if user.email != inv.email:
        raise HTTPException(
            403, detail={"code": "forbidden", "message": "invitation was issued to a different email"}
        )
    if db.get(OrgMembership, (inv.org_id, user.id)):
        raise HTTPException(409, detail={"code": "conflict", "message": "already a member"})
    db.add(OrgMembership(org_id=inv.org_id, user_id=user.id, role_id=inv.role_id))
    inv.accepted_at = now()
    db.commit()
    return StatusOk()


# --- audit ----------------------------------------------------------
@router.get("/orgs/{org_id}/audit-logs", response_model=ListResponse)
def list_audit_logs(
    org_id: uuid.UUID,
    instance_id: uuid.UUID | None = None,
    action: str | None = None,
    limit: int = 50,
    ctx: AuthContext = Depends(require("org:audit:read")),
    db: Session = Depends(get_db),
):
    q = select(AuditLog).where(AuditLog.org_id == org_id)
    if instance_id:
        q = q.where(AuditLog.instance_id == instance_id)
    if action:
        q = q.where(AuditLog.action == action)
    rows = db.scalars(q.order_by(AuditLog.created_at.desc()).limit(min(limit, 100))).all()
    return ListResponse(data=[AuditLogOut.model_validate(r) for r in rows])
