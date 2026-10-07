from functools import lru_cache

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    env: str = "dev"
    # App role DSN — must be app_api (no BYPASSRLS). Admin DSN is never used here.
    database_url: str = "postgresql://app_api:app_api_dev_only@localhost:5432/mawadao_agent_platform"
    # Per-instance pool: 2-4 connections max (Cloud SQL max_connections budget).
    db_pool_min: int = 1
    db_pool_max: int = 4
    # Dev-only HS256 secret; prod uses the IdP's JWKS (Phase 0 stub).
    jwt_secret: str = "dev-secret-change-me"
    jwt_algorithm: str = "HS256"
    # Browser origins allowed to call the API (comma-separated in AP_CORS_ORIGINS).
    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]
    # OpenRouter (hosted LLM gateway). Key comes from Secret Manager in prod.
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"

    model_config = {"env_prefix": "AP_"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
