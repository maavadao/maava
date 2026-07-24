import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from cryptography.fernet import Fernet, InvalidToken

from .config import settings

_fernet = Fernet(settings.fernet_key)

API_KEY_PREFIX = "pck_"


# --- passwords -----------------------------------------------------
def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), password_hash.encode())
    except ValueError:
        return False


# --- JWT access tokens ---------------------------------------------
def create_access_token(user_id: uuid.UUID) -> str:
    payload = {
        "sub": str(user_id),
        "iat": datetime.now(timezone.utc),
        "exp": datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_minutes),
        "typ": "access",
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> uuid.UUID | None:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        if payload.get("typ") != "access":
            return None
        return uuid.UUID(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        return None


# --- opaque tokens (refresh, invitations) ---------------------------
def new_opaque_token() -> tuple[str, str]:
    """Returns (secret, sha256_hash). Only the hash is stored."""
    secret = secrets.token_urlsafe(32)
    return secret, sha256(secret)


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


# --- API keys -------------------------------------------------------
def new_api_key() -> tuple[str, str, str]:
    """Returns (full_secret, display_prefix, sha256_hash)."""
    secret = API_KEY_PREFIX + secrets.token_urlsafe(32)
    return secret, secret[:12], sha256(secret)


# --- secrets at rest ------------------------------------------------
def encrypt(value: str) -> str:
    return _fernet.encrypt(value.encode()).decode()


def decrypt(value: str) -> str | None:
    try:
        return _fernet.decrypt(value.encode()).decode()
    except (InvalidToken, ValueError):
        return None
