"""RBAC-gated reverse proxy onto each instance's mawaDao Agent core launcher API.

Every rule below maps a manager route under /v1/instances/{instance_id}/... to a
launcher endpoint plus the permission required to call it (design doc §4.5).
Anything not listed — notably /api/auth/*, /api/system/*, /api/update — is
platform-only and returns 404 for tenants.
"""

import re
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from ..audit import set_action
from ..db import get_db
from ..proxy_client import forward, response_headers
from ..rbac import Principal, get_principal, require

router = APIRouter(prefix="/v1/instances/{instance_id}", tags=["instance-proxy"])

# (methods, subpath regex, required permission). First match wins.
PROXY_RULES: list[tuple[frozenset, re.Pattern, str]] = [
    (frozenset({"GET"}), re.compile(r"^gateway/status$"), "instance:read"),
    (frozenset({"POST"}), re.compile(r"^gateway/(start|stop|restart)$"), "instance:lifecycle"),
    (frozenset({"GET"}), re.compile(r"^gateway/logs$"), "instance:logs:read"),
    (frozenset({"POST"}), re.compile(r"^gateway/logs/clear$"), "instance:lifecycle"),

    (frozenset({"GET"}), re.compile(r"^config$"), "instance:config:read"),
    (frozenset({"PUT", "PATCH"}), re.compile(r"^config$"), "instance:config:write"),
    (frozenset({"POST"}), re.compile(r"^config/reset$"), "instance:config:write"),
    (frozenset({"POST"}), re.compile(r"^config/test-command-patterns$"), "instance:config:read"),

    (frozenset({"GET"}), re.compile(r"^models(/catalog)?$"), "instance:models:read"),
    (frozenset({"POST"}), re.compile(r"^models(/fetch|/default|/test-inline|/\d+/test)?$"), "instance:models:write"),
    (frozenset({"PUT", "DELETE"}), re.compile(r"^models/\d+$"), "instance:models:write"),
    (frozenset({"DELETE"}), re.compile(r"^models/catalog/[^/]+$"), "instance:models:write"),

    (frozenset({"GET"}), re.compile(r"^channels/catalog$"), "instance:channels:read"),
    (frozenset({"GET"}), re.compile(r"^channels/[^/]+/config$"), "instance:channels:read"),
    (frozenset({"POST"}), re.compile(r"^(weixin|wecom)/flows$"), "instance:channels:write"),
    (frozenset({"GET"}), re.compile(r"^(weixin|wecom)/flows/[^/]+$"), "instance:channels:write"),

    (frozenset({"GET"}), re.compile(r"^sessions(/[^/]+)?$"), "instance:sessions:read"),
    (frozenset({"DELETE"}), re.compile(r"^sessions/[^/]+$"), "instance:sessions:delete"),

    (frozenset({"GET"}), re.compile(r"^skills(/search|/[^/]+)?$"), "instance:skills:read"),
    (frozenset({"POST"}), re.compile(r"^skills/(install|import)$"), "instance:skills:write"),
    (frozenset({"DELETE"}), re.compile(r"^skills/[^/]+$"), "instance:skills:write"),

    (frozenset({"GET"}), re.compile(r"^tools(/web-search-config)?$"), "instance:tools:read"),
    (frozenset({"PUT"}), re.compile(r"^tools/web-search-config$"), "instance:tools:write"),
    (frozenset({"PUT"}), re.compile(r"^tools/[^/]+/state$"), "instance:tools:write"),

    (frozenset({"GET"}), re.compile(r"^oauth/providers$"), "instance:config:read"),
    (frozenset({"POST"}), re.compile(r"^oauth/(login|logout|flows/[^/]+/poll)$"), "instance:secrets:manage"),
    (frozenset({"GET"}), re.compile(r"^oauth/flows/[^/]+$"), "instance:secrets:manage"),

    (frozenset({"GET"}), re.compile(r"^pico/info$"), "instance:read"),
    (frozenset({"POST"}), re.compile(r"^pico/(setup|token)$"), "instance:secrets:manage"),

    (frozenset({"GET"}), re.compile(r"^media/[^/]+$"), "instance:console"),
]


def _match_rule(method: str, subpath: str) -> str | None:
    for methods, pattern, permission in PROXY_RULES:
        if method in methods and pattern.match(subpath):
            return permission
    return None


def _launcher_path(subpath: str) -> str:
    # media is served from the launcher's /pico/media proxy, not /api
    if subpath.startswith("media/"):
        return f"/pico/{subpath}"
    return f"/api/{subpath}"


@router.api_route(
    "/{subpath:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    name="instance_proxy",
)
async def proxy(
    instance_id: uuid.UUID,
    subpath: str,
    request: Request,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    subpath = subpath.strip("/")
    permission = _match_rule(request.method, subpath)
    if permission is None:
        raise HTTPException(404, detail={"code": "not_found", "message": "no such instance route"})

    # Standard RBAC dependency, invoked manually because the permission depends
    # on which subpath was matched. Raises 401/403/404 as usual and attaches
    # request.state.auth for the audit middleware.
    ctx = await run_in_threadpool(require(permission), request=request, principal=principal, db=db)

    body = await request.body()
    set_action(request, f"instance.proxy.{request.method.lower()}", f"/{subpath}")

    resp = await run_in_threadpool(
        forward,
        db,
        ctx.instance,
        request.method,
        _launcher_path(subpath),
        request.url.query,
        body,
        request.headers.get("content-type"),
    )
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers=response_headers(resp),
        media_type=resp.headers.get("content-type"),
    )
