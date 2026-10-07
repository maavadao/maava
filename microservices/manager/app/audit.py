"""Audit logging.

Mutating requests (POST/PUT/PATCH/DELETE) are logged by middleware in
app.main; routes can refine the recorded action via `set_action`. Denied
requests are logged with result="denied" (set by the RBAC dependency).
"""

import uuid

from fastapi import Request
from sqlalchemy.orm import Session

from .models import AuditLog

MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def set_action(request: Request, action: str, target: str = "") -> None:
    request.state.audit_action = action
    if target:
        request.state.audit_target = target


def write_audit(db: Session, request: Request, status_code: int) -> None:
    auth = getattr(request.state, "auth", None)
    if auth is None:
        return

    action = getattr(request.state, "audit_action", None)
    if action is None:
        action = f"{request.method.lower()} {request.url.path}"
    result = getattr(request.state, "audit_result", None)
    if result is None:
        result = "ok" if status_code < 400 else "error"

    principal = auth.principal
    db.add(
        AuditLog(
            org_id=auth.org_id,
            instance_id=auth.instance.id if auth.instance else None,
            actor_user_id=principal.user.id if principal.user else None,
            actor_api_key_id=principal.api_key.id if principal.api_key else None,
            action=action,
            target=getattr(request.state, "audit_target", request.url.path),
            request_meta={
                "method": request.method,
                "path": request.url.path,
                "ip": request.client.host if request.client else None,
                "user_agent": request.headers.get("user-agent", ""),
            },
            result=result,
        )
    )
    db.commit()
