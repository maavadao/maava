"""Leakage rules from the spec, asserted as two-tenant integration tests.

Every test runs as the unprivileged app_api role. If any of these fail, the
RLS hard floor is broken and nothing else matters.
"""
import psycopg
import pytest
from conftest import tenant

# ---------- cross-tenant isolation ----------

def test_org_b_cannot_see_org_a_agents(app_conn, fx):
    with tenant(app_conn, fx.org_b, fx.bob) as cur:
        cur.execute("SELECT name FROM agents")
        names = {r[0] for r in cur.fetchall()}
    assert names == {"bob-agent"}


def test_org_b_cannot_see_org_a_skills_or_versions(app_conn, fx):
    with tenant(app_conn, fx.org_b, fx.bob) as cur:
        cur.execute("SELECT count(*) FROM skills")
        assert cur.fetchone()[0] == 0
        cur.execute("SELECT count(*) FROM skill_versions")
        assert cur.fetchone()[0] == 0


def test_org_b_cannot_see_org_a_mcp_or_tool_schemas(app_conn, fx):
    with tenant(app_conn, fx.org_b, fx.bob) as cur:
        cur.execute("SELECT count(*) FROM mcp_servers")
        assert cur.fetchone()[0] == 0
        cur.execute("SELECT count(*) FROM mcp_tool_schemas")
        assert cur.fetchone()[0] == 0


def test_org_b_cannot_see_org_a_conversations_or_messages(app_conn, fx):
    with tenant(app_conn, fx.org_b, fx.bob) as cur:
        cur.execute("SELECT count(*) FROM conversations")
        assert cur.fetchone()[0] == 0
        cur.execute("SELECT count(*) FROM messages")
        assert cur.fetchone()[0] == 0


def test_cannot_insert_into_foreign_org(app_conn, fx):
    with pytest.raises(psycopg.errors.Error):
        with tenant(app_conn, fx.org_b, fx.bob) as cur:
            cur.execute(
                """INSERT INTO agents (org_id, owner_id, name, model)
                   VALUES (%s, %s, 'intruder', 'x')""",
                (fx.org_a, fx.bob),
            )


# ---------- intra-org privacy (private resources invisible to everyone else) ----------

def test_member_cannot_see_others_private_agent(app_conn, fx):
    with tenant(app_conn, fx.org_a, fx.adam) as cur:
        cur.execute("SELECT name FROM agents")
        names = {r[0] for r in cur.fetchall()}
    assert names == {"alice-shared"}


def test_member_cannot_see_others_private_skill(app_conn, fx):
    with tenant(app_conn, fx.org_a, fx.adam) as cur:
        cur.execute("SELECT count(*) FROM skills")
        assert cur.fetchone()[0] == 0
        cur.execute("SELECT count(*) FROM skill_versions")
        assert cur.fetchone()[0] == 0


def test_member_cannot_see_others_conversations(app_conn, fx):
    with tenant(app_conn, fx.org_a, fx.adam) as cur:
        cur.execute("SELECT count(*) FROM conversations")
        assert cur.fetchone()[0] == 0
        cur.execute("SELECT count(*) FROM messages")
        assert cur.fetchone()[0] == 0


def test_member_cannot_update_others_agent(app_conn, fx):
    with tenant(app_conn, fx.org_a, fx.adam) as cur:
        cur.execute("UPDATE agents SET name = 'hijacked' WHERE id = %s", (fx.agent_a_org,))
        assert cur.rowcount == 0  # RLS filters the row out of the UPDATE


def test_owner_sees_own_private_and_org_resources(app_conn, fx):
    with tenant(app_conn, fx.org_a, fx.alice) as cur:
        cur.execute("SELECT name FROM agents ORDER BY name")
        assert [r[0] for r in cur.fetchall()] == ["alice-private", "alice-shared"]
        cur.execute("SELECT count(*) FROM skill_versions")
        assert cur.fetchone()[0] == 1


# ---------- fail-closed behavior ----------

def test_no_tenant_context_returns_no_rows(app_conn, fx):
    with app_conn.transaction():
        with app_conn.cursor() as cur:
            for table in ("agents", "skills", "mcp_servers", "conversations", "messages"):
                cur.execute(f"SELECT count(*) FROM {table}")  # noqa: S608 — test-only
                assert cur.fetchone()[0] == 0, f"{table} leaked rows without tenant context"


def test_app_role_has_no_bypassrls_or_superuser(app_conn):
    with app_conn.cursor() as cur:
        cur.execute("SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user")
        bypass, super_ = cur.fetchone()
    assert not bypass and not super_


# ---------- append-only guarantees ----------

def test_messages_are_append_only(app_conn, fx):
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with tenant(app_conn, fx.org_a, fx.alice) as cur:
            cur.execute("UPDATE messages SET content = '[]' WHERE id = %s", (fx.msg_alice,))
    app_conn.rollback()
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with tenant(app_conn, fx.org_a, fx.alice) as cur:
            cur.execute("DELETE FROM messages WHERE id = %s", (fx.msg_alice,))


def test_audit_events_readable_only_by_admins(app_conn, fx):
    with tenant(app_conn, fx.org_a, fx.alice) as cur:  # owner
        cur.execute("INSERT INTO audit_events (org_id, actor_id, action, resource_type) "
                    "VALUES (%s, %s, 'test.event', 'test')", (fx.org_a, fx.alice))
        cur.execute("SELECT count(*) FROM audit_events")
        assert cur.fetchone()[0] == 1
    with tenant(app_conn, fx.org_a, fx.adam) as cur:  # member
        cur.execute("SELECT count(*) FROM audit_events")
        assert cur.fetchone()[0] == 0


# ---------- signup bootstrap ----------

def test_create_org_with_owner(app_conn):
    import uuid
    new_user = uuid.uuid4()
    with tenant(app_conn, None, new_user) as cur:
        cur.execute("INSERT INTO users (id, email) VALUES (%s, %s)",
                    (new_user, f"{new_user}@signup.test"))
        cur.execute("SELECT create_org_with_owner('New Org')")
        org_id = cur.fetchone()[0]
        cur.execute("SELECT role FROM memberships WHERE org_id = %s AND user_id = %s",
                    (org_id, new_user))
        assert cur.fetchone()[0] == "owner"
    app_conn.rollback()  # keep fixture data clean
