from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .audit import MUTATING_METHODS, write_audit
from .db import Base, SessionLocal, engine
from .routers import api_keys, auth, instances, orgs, proxy, roles
from .seed import seed


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        seed(db)
    yield


app = FastAPI(
    title="mawa Manager",
    version="0.1.0",
    description=(
        "Multi-tenant management API for hosted mawa core instances with "
        "org/instance-scoped RBAC. Instance routes proxy to each instance's "
        "launcher API using platform-held credentials."
    ),
    lifespan=lifespan,
)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    detail = exc.detail
    if isinstance(detail, str):
        detail = {"code": "error", "message": detail}
    return JSONResponse(status_code=exc.status_code, content={"error": detail})


@app.middleware("http")
async def audit_middleware(request: Request, call_next):
    response = await call_next(request)
    # Log every authorized mutating call, every proxy call, and every denial.
    auth = getattr(request.state, "auth", None)
    if auth is not None and (
        request.method in MUTATING_METHODS
        or getattr(request.state, "audit_action", None)
        or getattr(request.state, "audit_result", None) == "denied"
    ):
        def _log():
            with SessionLocal() as db:
                write_audit(db, request, response.status_code)

        await run_in_threadpool(_log)
    return response


@app.get("/healthz", tags=["system"])
def healthz():
    return {"status": "ok"}


app.include_router(auth.router)
app.include_router(orgs.router)
app.include_router(roles.router)
app.include_router(api_keys.router)
app.include_router(instances.router)
app.include_router(proxy.router)  # keep last: catch-all under /v1/instances/{id}/
