import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --- auth -----------------------------------------------------------
class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    display_name: str = ""
    org_name: str | None = None  # optionally create a first org


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int


class RefreshRequest(BaseModel):
    refresh_token: str


class UpdateMeRequest(BaseModel):
    display_name: str | None = None
    current_password: str | None = None
    new_password: str | None = Field(default=None, min_length=8)


class UserOut(ORMModel):
    id: uuid.UUID
    email: str
    display_name: str
    is_platform_admin: bool
    status: str
    created_at: datetime


class MembershipOut(BaseModel):
    org_id: uuid.UUID
    org_slug: str
    org_name: str
    role: str


class MeResponse(BaseModel):
    user: UserOut
    memberships: list[MembershipOut]


# --- orgs -----------------------------------------------------------
class OrgCreate(BaseModel):
    name: str = Field(min_length=1)
    slug: str = Field(min_length=1, max_length=63, pattern=r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")


class OrgUpdate(BaseModel):
    name: str | None = None


class OrgOut(ORMModel):
    id: uuid.UUID
    slug: str
    name: str
    status: str
    created_at: datetime


class MemberOut(BaseModel):
    user_id: uuid.UUID
    email: str
    display_name: str
    role: str
    joined_at: datetime


class MemberUpdate(BaseModel):
    role: str


class InvitationCreate(BaseModel):
    email: EmailStr
    role: str


class InvitationOut(ORMModel):
    id: uuid.UUID
    email: str
    expires_at: datetime
    accepted_at: datetime | None
    created_at: datetime


class InvitationCreated(InvitationOut):
    # returned once; in production this would be emailed, not returned
    token: str


class InvitationAccept(BaseModel):
    token: str


# --- roles ----------------------------------------------------------
class RoleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str = ""
    permissions: list[str]


class RoleUpdate(BaseModel):
    description: str | None = None
    permissions: list[str] | None = None


class RoleOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str
    is_system: bool
    permissions: list[str]


# --- api keys -------------------------------------------------------
class ApiKeyCreate(BaseModel):
    name: str = Field(min_length=1)
    permissions: list[str]
    instance_ids: list[uuid.UUID] | None = None
    expires_at: datetime | None = None


class ApiKeyOut(ORMModel):
    id: uuid.UUID
    name: str
    key_prefix: str
    permissions: list[str]
    instance_ids: list[str] | None
    expires_at: datetime | None
    last_used_at: datetime | None
    created_at: datetime


class ApiKeyCreated(ApiKeyOut):
    secret: str  # returned exactly once


# --- instances ------------------------------------------------------
class InstanceCreate(BaseModel):
    name: str = Field(min_length=1)
    slug: str = Field(min_length=1, max_length=63, pattern=r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")
    region: str = "default"
    plan: str | None = None  # plan name; default plan when omitted
    labels: dict[str, str] = {}


class InstanceUpdate(BaseModel):
    name: str | None = None
    labels: dict[str, str] | None = None
    plan: str | None = None


class InstanceOut(ORMModel):
    id: uuid.UUID
    org_id: uuid.UUID
    name: str
    slug: str
    region: str
    status: str
    status_message: str
    labels: dict
    desired_version: str | None
    created_at: datetime
    updated_at: datetime


class RoleBindingPut(BaseModel):
    role: str


class RoleBindingOut(BaseModel):
    user_id: uuid.UUID
    email: str
    role: str
    created_at: datetime


# --- audit ----------------------------------------------------------
class AuditLogOut(ORMModel):
    id: int
    org_id: uuid.UUID | None
    instance_id: uuid.UUID | None
    actor_user_id: uuid.UUID | None
    actor_api_key_id: uuid.UUID | None
    action: str
    target: str
    request_meta: dict
    result: str
    created_at: datetime


# --- generic --------------------------------------------------------
class ListResponse(BaseModel):
    data: list
    next_cursor: str | None = None


class StatusOk(BaseModel):
    status: str = "ok"
