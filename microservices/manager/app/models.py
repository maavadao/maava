import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def now() -> datetime:
    return datetime.now(timezone.utc)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


# ===================================================================
# Identity & tenancy
# ===================================================================
class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str | None] = mapped_column(Text)
    display_name: Mapped[str] = mapped_column(Text, default="")
    is_platform_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(32), default="active")  # active|disabled|pending_verification
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    memberships: Mapped[list["OrgMembership"]] = relationship(back_populates="user")


class Organization(Base, TimestampMixin):
    __tablename__ = "organizations"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    slug: Mapped[str] = mapped_column(String(63), unique=True, index=True)
    name: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="active")  # active|suspended|deleting
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    memberships: Mapped[list["OrgMembership"]] = relationship(back_populates="org")


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    user_agent: Mapped[str | None] = mapped_column(Text)
    ip: Mapped[str | None] = mapped_column(String(64))


# ===================================================================
# RBAC
# ===================================================================
class Role(Base):
    __tablename__ = "roles"
    __table_args__ = (UniqueConstraint("org_id", "name"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )  # NULL = built-in system role
    name: Mapped[str] = mapped_column(String(64))
    description: Mapped[str] = mapped_column(Text, default="")
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    permissions: Mapped[list["RolePermission"]] = relationship(
        back_populates="role", cascade="all, delete-orphan"
    )

    @property
    def permission_ids(self) -> list[str]:
        return [p.permission_id for p in self.permissions]


class Permission(Base):
    __tablename__ = "permissions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)


class RolePermission(Base):
    __tablename__ = "role_permissions"

    role_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True
    )
    permission_id: Mapped[str] = mapped_column(
        ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True
    )

    role: Mapped[Role] = relationship(back_populates="permissions")


class OrgMembership(Base):
    __tablename__ = "org_memberships"

    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    role_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("roles.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    org: Mapped[Organization] = relationship(back_populates="memberships")
    user: Mapped[User] = relationship(back_populates="memberships")
    role: Mapped[Role] = relationship()


class InstanceRoleBinding(Base):
    __tablename__ = "instance_role_bindings"

    instance_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("instances.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("roles.id"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    role: Mapped[Role] = relationship()


class Invitation(Base):
    __tablename__ = "invitations"
    __table_args__ = (UniqueConstraint("org_id", "email"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    email: Mapped[str] = mapped_column(String(320))
    role_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("roles.id"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    invited_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class ApiKey(Base):
    __tablename__ = "api_keys"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(Text)
    key_prefix: Mapped[str] = mapped_column(String(16))
    key_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    permissions: Mapped[list] = mapped_column(JSON)  # explicit subset of permission ids
    instance_ids: Mapped[list | None] = mapped_column(JSON)  # null = all org instances
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


# ===================================================================
# Instances
# ===================================================================
class Plan(Base):
    __tablename__ = "plans"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(64), unique=True)
    cpu_millicores: Mapped[int] = mapped_column(Integer)
    memory_mb: Mapped[int] = mapped_column(Integer)
    storage_gb: Mapped[int] = mapped_column(Integer)
    max_instances: Mapped[int] = mapped_column(Integer, default=1)
    price_cents_month: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


INSTANCE_STATUSES = ("provisioning", "running", "degraded", "suspended", "stopped", "deleting", "error")


class Instance(Base, TimestampMixin):
    __tablename__ = "instances"
    __table_args__ = (UniqueConstraint("org_id", "slug"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True)
    plan_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("plans.id"))
    name: Mapped[str] = mapped_column(Text)
    slug: Mapped[str] = mapped_column(String(63))
    region: Mapped[str] = mapped_column(String(64), default="default")
    status: Mapped[str] = mapped_column(String(32), default="provisioning", index=True)
    status_message: Mapped[str] = mapped_column(Text, default="")
    labels: Mapped[dict] = mapped_column(JSON, default=dict)
    desired_version: Mapped[str | None] = mapped_column(String(64))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    credentials: Mapped["InstanceCredentials | None"] = relationship(
        cascade="all, delete-orphan", uselist=False
    )
    endpoint: Mapped["InstanceEndpoint | None"] = relationship(
        cascade="all, delete-orphan", uselist=False
    )


class InstanceCredentials(Base):
    """Platform-held secrets for reaching the instance's launcher/gateway.

    All secret columns are Fernet-encrypted by app.security before storage.
    """

    __tablename__ = "instance_credentials"

    instance_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("instances.id", ondelete="CASCADE"), primary_key=True
    )
    launcher_password: Mapped[str] = mapped_column(Text)
    launcher_session: Mapped[str | None] = mapped_column(Text)
    session_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    gateway_pidfile_token: Mapped[str | None] = mapped_column(Text)
    pico_token: Mapped[str | None] = mapped_column(Text)
    kms_key_id: Mapped[str] = mapped_column(String(128), default="local")
    rotated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class InstanceEndpoint(Base):
    __tablename__ = "instance_endpoints"

    instance_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("instances.id", ondelete="CASCADE"), primary_key=True
    )
    launcher_url: Mapped[str] = mapped_column(Text)  # http://svc.ns.svc.cluster.local:18800
    gateway_url: Mapped[str] = mapped_column(Text)  # ...:18790
    external_url: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class InstanceHealth(Base):
    __tablename__ = "instance_health"

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True)
    instance_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("instances.id", ondelete="CASCADE"), index=True
    )
    gateway_status: Mapped[str] = mapped_column(String(32))
    healthy: Mapped[bool] = mapped_column(Boolean)
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)


# ===================================================================
# Audit
# ===================================================================
class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True)
    org_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="SET NULL"), index=True
    )
    instance_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("instances.id", ondelete="SET NULL"), index=True
    )
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    actor_api_key_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("api_keys.id", ondelete="SET NULL"))
    action: Mapped[str] = mapped_column(String(128), index=True)
    target: Mapped[str] = mapped_column(Text, default="")
    request_meta: Mapped[dict] = mapped_column(JSON, default=dict)
    result: Mapped[str] = mapped_column(String(16), default="ok")  # ok|denied|error
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)


# ===================================================================
# FUTURE: Kubernetes deployment layer (tables reserved, no endpoints yet)
# ===================================================================
class Cluster(Base):
    __tablename__ = "clusters"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(64), unique=True)
    region: Mapped[str] = mapped_column(String(64))
    api_server_url: Mapped[str] = mapped_column(Text)
    ca_cert: Mapped[str] = mapped_column(Text)
    credentials: Mapped[str] = mapped_column(Text)  # encrypted SA token / kubeconfig
    kms_key_id: Mapped[str] = mapped_column(String(128), default="local")
    capacity: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(32), default="active")  # active|cordoned|draining|offline
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Release(Base):
    __tablename__ = "releases"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    version: Mapped[str] = mapped_column(String(64), unique=True)
    image: Mapped[str] = mapped_column(Text)
    channel: Mapped[str] = mapped_column(String(16), default="stable")  # stable|beta|deprecated
    notes: Mapped[str] = mapped_column(Text, default="")
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class InstanceDeployment(Base):
    __tablename__ = "instance_deployments"
    __table_args__ = (UniqueConstraint("cluster_id", "namespace"),)

    instance_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("instances.id", ondelete="CASCADE"), primary_key=True
    )
    cluster_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clusters.id"))
    namespace: Mapped[str] = mapped_column(String(63))
    release_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("releases.id"))
    desired_replicas: Mapped[int] = mapped_column(Integer, default=1)  # 0 = suspended
    resources: Mapped[dict] = mapped_column(JSON, default=dict)
    storage_class: Mapped[str | None] = mapped_column(String(64))
    pvc_name: Mapped[str | None] = mapped_column(String(64))
    ingress_host: Mapped[str | None] = mapped_column(Text)
    generation: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), default=1)
    observed_generation: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), default=0
    )
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class DeploymentOperation(Base):
    __tablename__ = "deployment_operations"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    instance_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("instances.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(32))  # provision|upgrade|scale|suspend|resume|migrate|deprovision
    from_release_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("releases.id"))
    to_release_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("releases.id"))
    status: Mapped[str] = mapped_column(String(32), default="pending")
    error: Mapped[str] = mapped_column(Text, default="")
    requested_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
