import base64
import hashlib

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # sqlite default so the API runs out of the box; point at Postgres in prod:
    # postgresql+psycopg://user:pass@host/paas
    database_url: str = "sqlite:///./paas.db"

    jwt_secret: str = "change-me-in-prod"
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 30
    refresh_token_days: int = 30

    # Fernet key for encrypting instance credentials at rest. If unset, derived
    # from jwt_secret (fine for dev, use a dedicated KMS-backed key in prod).
    encryption_key: str = ""

    invitation_ttl_days: int = 7
    proxy_timeout_seconds: float = 30.0

    class Config:
        env_prefix = "PAAS_"
        env_file = ".env"

    @property
    def fernet_key(self) -> bytes:
        if self.encryption_key:
            return self.encryption_key.encode()
        digest = hashlib.sha256(self.jwt_secret.encode()).digest()
        return base64.urlsafe_b64encode(digest)


settings = Settings()
