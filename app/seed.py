"""Idempotent seed: permission catalog, built-in roles, default plans."""

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .models import Permission, Plan, Role, RolePermission
from .rbac import ALL_PERMISSIONS, BUILTIN_ROLES

DEFAULT_PLANS = [
    # name, cpu_m, mem_mb, storage_gb, max_instances, price_cents
    ("free", 250, 512, 1, 1, 0),
    ("pro", 1000, 2048, 10, 5, 2900),
    ("enterprise", 4000, 8192, 50, 50, 19900),
]

ROLE_DESCRIPTIONS = {
    "owner": "Full control including billing and org deletion",
    "admin": "Full instance management and member administration",
    "operator": "Day-2 operations: lifecycle, config, channels, logs",
    "developer": "Models, skills, tools and console access",
    "viewer": "Read-only access",
    "billing": "Billing management only",
}


def seed(db: Session) -> None:
    existing = {p.id for p in db.scalars(select(Permission))}
    for perm in ALL_PERMISSIONS:
        if perm not in existing:
            db.add(Permission(id=perm))
    db.flush()

    system_roles = {
        r.name: r
        for r in db.scalars(
            select(Role).where(Role.is_system.is_(True)).options(selectinload(Role.permissions))
        )
    }
    for name, perms in BUILTIN_ROLES.items():
        role = system_roles.get(name)
        if role is None:
            role = Role(
                org_id=None,
                name=name,
                description=ROLE_DESCRIPTIONS.get(name, ""),
                is_system=True,
            )
            db.add(role)
            db.flush()
        current = set(role.permission_ids)
        for p in perms - current:
            db.add(RolePermission(role_id=role.id, permission_id=p))
        for rp in list(role.permissions):
            if rp.permission_id not in perms:
                db.delete(rp)

    existing_plans = {p.name for p in db.scalars(select(Plan))}
    for name, cpu, mem, storage, max_inst, price in DEFAULT_PLANS:
        if name not in existing_plans:
            db.add(
                Plan(
                    name=name,
                    cpu_millicores=cpu,
                    memory_mb=mem,
                    storage_gb=storage,
                    max_instances=max_inst,
                    price_cents_month=price,
                )
            )
    db.commit()
