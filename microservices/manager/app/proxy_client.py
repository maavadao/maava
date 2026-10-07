"""HTTP client for reaching a customer instance's launcher API.

The platform owns each instance's launcher dashboard password
(instance_credentials.launcher_password, encrypted). This module logs in with
it, caches the resulting `picoclaw_launcher_auth` session cookie (encrypted),
and forwards requests. On a 401 (session expired / launcher restarted) it
re-authenticates once and retries.
"""

from datetime import timedelta

import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session

from .config import settings
from .models import Instance, InstanceCredentials, InstanceEndpoint, now
from .security import decrypt, encrypt

SESSION_COOKIE = "picoclaw_launcher_auth"
# Launcher cookies last 31 days; refresh well before that.
SESSION_TTL = timedelta(days=7)

# Hop-by-hop / connection headers never forwarded either way.
_SKIP_HEADERS = {
    "host", "connection", "keep-alive", "transfer-encoding", "upgrade",
    "proxy-authenticate", "proxy-authorization", "te", "trailers",
    "content-length", "authorization", "cookie", "set-cookie",
}


def _endpoint(db: Session, instance: Instance) -> InstanceEndpoint:
    endpoint = db.get(InstanceEndpoint, instance.id)
    if endpoint is None:
        raise HTTPException(
            503, detail={"code": "unavailable", "message": "instance has no endpoint yet"}
        )
    return endpoint


def _credentials(db: Session, instance: Instance) -> InstanceCredentials:
    creds = db.get(InstanceCredentials, instance.id)
    if creds is None:
        raise HTTPException(
            503, detail={"code": "unavailable", "message": "instance credentials not provisioned"}
        )
    return creds


def _login(client: httpx.Client, base_url: str, db: Session, creds: InstanceCredentials) -> str:
    password = decrypt(creds.launcher_password)
    if password is None:
        raise HTTPException(
            500, detail={"code": "internal", "message": "cannot decrypt launcher credential"}
        )
    try:
        resp = client.post(f"{base_url}/api/auth/login", json={"password": password})
    except httpx.HTTPError:
        raise HTTPException(
            503, detail={"code": "unavailable", "message": "instance launcher unreachable"}
        )
    if resp.status_code != 200:
        raise HTTPException(
            502,
            detail={"code": "bad_gateway", "message": f"launcher login failed ({resp.status_code})"},
        )
    cookie = resp.cookies.get(SESSION_COOKIE)
    if not cookie:
        raise HTTPException(
            502, detail={"code": "bad_gateway", "message": "launcher did not set a session cookie"}
        )
    creds.launcher_session = encrypt(cookie)
    creds.session_expires_at = now() + SESSION_TTL
    db.commit()
    return cookie


def _cached_session(creds: InstanceCredentials) -> str | None:
    if not creds.launcher_session or not creds.session_expires_at:
        return None
    expires = creds.session_expires_at
    if expires.tzinfo is None:
        from datetime import timezone

        expires = expires.replace(tzinfo=timezone.utc)
    if expires < now():
        return None
    return decrypt(creds.launcher_session)


def forward(
    db: Session,
    instance: Instance,
    method: str,
    launcher_path: str,
    query: str,
    body: bytes,
    content_type: str | None,
) -> httpx.Response:
    if instance.status not in ("running", "degraded"):
        raise HTTPException(
            409,
            detail={"code": "conflict", "message": f"instance is {instance.status}, not reachable"},
        )
    endpoint = _endpoint(db, instance)
    creds = _credentials(db, instance)
    base = endpoint.launcher_url.rstrip("/")
    url = f"{base}{launcher_path}" + (f"?{query}" if query else "")

    headers = {}
    if content_type:
        headers["Content-Type"] = content_type

    with httpx.Client(timeout=settings.proxy_timeout_seconds) as client:
        session = _cached_session(creds) or _login(client, base, db, creds)
        for attempt in (1, 2):
            try:
                resp = client.request(
                    method,
                    url,
                    content=body or None,
                    headers=headers,
                    cookies={SESSION_COOKIE: session},
                )
            except httpx.HTTPError:
                raise HTTPException(
                    503, detail={"code": "unavailable", "message": "instance launcher unreachable"}
                )
            if resp.status_code == 401 and attempt == 1:
                session = _login(client, base, db, creds)
                continue
            return resp
    return resp  # unreachable


def response_headers(resp: httpx.Response) -> dict[str, str]:
    return {k: v for k, v in resp.headers.items() if k.lower() not in _SKIP_HEADERS}
