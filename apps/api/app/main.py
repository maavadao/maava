from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import db
from .routes import agents, me


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_pool()
    yield
    await db.close_pool()


app = FastAPI(title="Agent Platform API", lifespan=lifespan)
app.include_router(me.router, prefix="/v1")
app.include_router(agents.router, prefix="/v1")


@app.get("/healthz")
async def healthz():
    return {"ok": True}
