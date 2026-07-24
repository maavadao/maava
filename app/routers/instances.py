import secrets
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from ..audit import set_action
from ..db import get_db
from ..models import (
    Instance,
    InstanceCredentials,
    InstanceEndpoint,
    InstanceRoleBinding,
    Organization,
    Plan,
    User,
    now,
)
from ..rbac import AuthContext, require
from ..schemas import (
    InstanceCreate,
    InstanceOut,
    InstanceUpdate,
    ListResponse,
    RoleBindingOut,
    RoleBindingPut,
    StatusOk,
)
from ..security import encrypt
from .orgs import resolve_role

router = APIRouter(prefix="/v1", tags=["instances"])


def _get_plan(db: Session, name: str | None) -> Plan:
    q = select(Plan).where(Plan.is_active.is_(True))
    plan = db.scalar(q.where(Plan.name == name)) if name else db.scalar(q.order_by(Plan.price_cents_month))
    if plan is None:
        raise HTTPException(400, detail={"code": "invalid_plan", "message": f"unknown plan {name}"})
    return plan


@router.post("/orgs/{org_id}/instances", response_model=InstanceOut, status_code=201)
def create_instance(
    org_id: uuid.UUID,
    body: InstanceCreate,
    request: Request,
    ctx: AuthContext = Depends(require("instance:create")),
    db: Session = Depends(get_db),
):
    org = db.get(Organization, org_id)
    if org is None or org.deleted_at is not None:
        raise HTTPException(404, detail={"code": "not_found", "message": "org not found"})
    if db.scalar(select(Instance).where(Instance.org_id == org_id, Instance.slug == body.slug)):
        raise HTTPException(409, detail={"code": "conflict", "message": "slug already used in this org"})

    plan = _get_plan(db, body.plan)
    on_plan = db.scalar(
        select(func.count())
        .select_from(Instance)
        .where(Instance.org_id == org_id, Instance.plan_id == plan.id, Instance.deleted_at.is_(None))
    )
    if on_plan >= plan.max_instances:
        raise HTTPException(
            409,
            detail={"code": "quota_exceeded", "message": f"plan {plan.name} allows {plan.max_instances} instance(s)"},
        )

    instance = Instance(
        org_id=org_id,
        plan_id=plan.id,
        name=body.name,
        slug=body.slug,
        region=body.region,
        labels=body.labels,
        status="provisioning",
        status_message="waiting for deployment",
        created_by=ctx.principal.user.id if ctx.principal.user else None,
    )
    db.add(instance)
    db.flush()

    # Platform-generated launcher credential; the deployment layer will use it
    # to run POST /api/auth/setup on first boot. Customers never see it.
    namespace = f"pc-{org.slug}-{body.slug}"
    db.add(
        InstanceCredentials(
            instance_id=instance.id,
            launcher_password=encrypt(secrets.token_urlsafe(24)),
        )
    )
    db.add(
        InstanceEndpoint(
            instance_id=instance.id,
            launcher_url=f"http://launcher.{namespace}.svc.cluster.local:18800",
            gateway_url=f"http://gateway.{namespace}.svc.cluster.local:18790",
        )
    )
    db.commit()
    set_action(request, "instance.create", str(instance.id))
    return InstanceOut.model_validate(instance)


@router.get("/orgs/{org_id}/instances", response_model=ListResponse)
def list_instances(
    org_id: uuid.UUID,
    status: str | None = None,
    ctx: AuthContext = Depends(require("instance:read")),
    db: Session = Depends(get_db),
):
    q = select(Instance).where(Instance.org_id == org_id, Instance.deleted_at.is_(None))
    if status:
        q = q.where(Instance.status == status)
    rows = db.scalars(q.order_by(Instance.created_at)).all()
    return ListResponse(data=[InstanceOut.model_validate(i) for i in rows])


@router.get("/instances/{instance_id}", response_model=InstanceOut)
def get_instance(instance_id: uuid.UUID, ctx: AuthContext = Depends(require("instance:read"))):
    return InstanceOut.model_validate(ctx.instance)


@router.patch("/instances/{instance_id}", response_model=InstanceOut)
def update_instance(
    instance_id: uuid.UUID,
    body: InstanceUpdate,
    request: Request,
    ctx: AuthContext = Depends(require("instance:update")),
    db: Session = Depends(get_db),
):
    instance = db.get(Instance, ctx.instance.id)
    if body.name is not None:
        instance.name = body.name
    if body.labels is not None:
        instance.labels = body.labels
    if body.plan is not None:
        instance.plan_id = _get_plan(db, body.plan).id
    db.commit()
    set_action(request, "instance.update", str(instance.id))
    return InstanceOut.model_validate(instance)


@router.delete("/instances/{instance_id}", response_model=StatusOk)
def delete_instance(
    instance_id: uuid.UUID,
    request: Request,
    ctx: AuthContext = Depends(require("instance:delete")),
    db: Session = Depends(get_db),
):
    instance = db.get(Instance, ctx.instance.id)
    instance.deleted_at = now()
    instance.status = "deleting"
    instance.status_message = "deprovision requested"
    db.commit()
    set_action(request, "instance.delete", str(instance.id))
    return StatusOk()


@router.post("/instances/{instance_id}/suspend", response_model=InstanceOut)
def suspend_instance(
    instance_id: uuid.UUID,
    request: Request,
    ctx: AuthContext = Depends(require("instance:lifecycle")),
    db: Session = Depends(get_db),
):
    instance = db.get(Instance, ctx.instance.id)
    if instance.status == "suspended":
        return InstanceOut.model_validate(instance)
    instance.status = "suspended"
    instance.status_message = "suspended by user"
    db.commit()
    set_action(request, "instance.suspend", str(instance.id))
    return InstanceOut.model_validate(instance)


@router.post("/instances/{instance_id}/resume", response_model=InstanceOut)
def resume_instance(
    instance_id: uuid.UUID,
    request: Request,
    ctx: AuthContext = Depends(require("instance:lifecycle")),
    db: Session = Depends(get_db),
):
    instance = db.get(Instance, ctx.instance.id)
    if instance.status != "suspended":
        raise HTTPException(409, detail={"code": "conflict", "message": "instance is not suspended"})
    instance.status = "provisioning"
    instance.status_message = "resume requested"
    db.commit()
    set_action(request, "instance.resume", str(instance.id))
    return InstanceOut.model_validate(instance)


# --- instance-scoped role bindings ---------------------------------
@router.get("/instances/{instance_id}/role-bindings", response_model=ListResponse)
def list_role_bindings(
    instance_id: uuid.UUID,
    ctx: AuthContext = Depends(require("org:members:read")),
    db: Session = Depends(get_db),
):
    bindings = db.scalars(
        select(InstanceRoleBinding)
        .where(InstanceRoleBinding.instance_id == ctx.instance.id)
        .options(selectinload(InstanceRoleBinding.role))
    ).all()
    users = {u.id: u for u in db.scalars(select(User).where(User.id.in_([b.user_id for b in bindings])))}
    return ListResponse(
        data=[
            RoleBindingOut(
                user_id=b.user_id,
                email=users[b.user_id].email if b.user_id in users else "",
                role=b.role.name,
                created_at=b.created_at,
            )
            for b in bindings
        ]
    )


@router.put("/instances/{instance_id}/role-bindings/{user_id}", response_model=StatusOk)
def put_role_binding(
    instance_id: uuid.UUID,
    user_id: uuid.UUID,
    body: RoleBindingPut,
    request: Request,
    ctx: AuthContext = Depends(require("org:members:manage")),
    db: Session = Depends(get_db),
):
    user = db.get(User, user_id)
    if user is None or user.deleted_at is not None:
        raise HTTPException(404, detail={"code": "not_found", "message": "user not found"})
    role = resolve_role(db, ctx.instance.org_id, body.role)
    binding = db.get(InstanceRoleBinding, (ctx.instance.id, user_id))
    if binding is None:
        db.add(
            InstanceRoleBinding(
                instance_id=ctx.instance.id,
                user_id=user_id,
                role_id=role.id,
                created_by=ctx.principal.user.id if ctx.principal.user else None,
            )
        )
    else:
        binding.role_id = role.id
    db.commit()
    set_action(request, "instance.role_binding.put", str(user_id))
    return StatusOk()


@router.delete("/instances/{instance_id}/role-bindings/{user_id}", response_model=StatusOk)
def delete_role_binding(
    instance_id: uuid.UUID,
    user_id: uuid.UUID,
    request: Request,
    ctx: AuthContext = Depends(require("org:members:manage")),
    db: Session = Depends(get_db),
):
    binding = db.get(InstanceRoleBinding, (ctx.instance.id, user_id))
    if binding is None:
        raise HTTPException(404, detail={"code": "not_found", "message": "binding not found"})
    db.delete(binding)
    db.commit()
    set_action(request, "instance.role_binding.delete", str(user_id))
    return StatusOk()
