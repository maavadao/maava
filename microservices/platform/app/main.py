from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import db
from .config import get_settings
from .routes import agents, conversations, me


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_pool()
    yield
    await db.close_pool()


app = FastAPI(title="maava Platform API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type"],
)
app.include_router(me.router, prefix="/v1")
app.include_router(agents.router, prefix="/v1")
app.include_router(conversations.router, prefix="/v1")


@app.get("/healthz")
async def healthz():
    return {"ok": True}
