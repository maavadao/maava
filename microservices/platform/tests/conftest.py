"""Two-tenant leakage test harness.

Seeds fixtures as the admin role (table owner, bypasses RLS), then runs
assertions over a connection using the unprivileged app_api role — exactly how
the API sees the database.

Layout:
  org A: alice (owner)  — private agent, org-visible agent, private skill,
                          org-visible mcp server, conversation + messages
         adam  (member)
  org B: bob   (owner)  — his own agent
"""
import os
import uuid
from contextlib import contextmanager

import psycopg
import pytest

ADMIN_DSN = os.environ.get(
    "ADMIN_DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/mawadao_agent_platform"
)
APP_DSN = os.environ.get(
    "APP_DATABASE_URL", "postgresql://app_api:app_api_dev_only@localhost:5432/mawadao_agent_platform"
)

TABLES = [
    "tool_calls", "messages", "conversations", "agent_mcp", "agent_skills",
    "mcp_tool_schemas", "mcp_servers", "skill_versions", "skills", "agents",
    "audit_events", "memberships", "users", "orgs",
]


class Fixtures:
    def __init__(self):
        self.org_a = uuid.uuid4()
        self.org_b = uuid.uuid4()
        self.alice = uuid.uuid4()   # org A owner
        self.adam = uuid.uuid4()    # org A member
        self.bob = uuid.uuid4()     # org B owner
        self.agent_a_private = uuid.uuid4()
        self.agent_a_org = uuid.uuid4()
        self.agent_b = uuid.uuid4()
        self.skill_a_private = uuid.uuid4()
        self.skill_a_version = uuid.uuid4()
        self.mcp_a_org = uuid.uuid4()
        self.convo_alice = uuid.uuid4()
        self.msg_alice = uuid.uuid4()


@pytest.fixture(scope="session")
def fx():
    f = Fixtures()
    with psycopg.connect(ADMIN_DSN) as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE " + ", ".join(TABLES) + " CASCADE")
        cur.execute("INSERT INTO orgs (id, name) VALUES (%s,'Org A'), (%s,'Org B')",
                    (f.org_a, f.org_b))
        cur.execute(
            "INSERT INTO users (id, email) VALUES "
            "(%s,'alice@a.test'), (%s,'adam@a.test'), (%s,'bob@b.test')",
            (f.alice, f.adam, f.bob))
        cur.execute(
            """INSERT INTO memberships (org_id, user_id, role) VALUES
               (%s,%s,'owner'), (%s,%s,'member'), (%s,%s,'owner')""",
            (f.org_a, f.alice, f.org_a, f.adam, f.org_b, f.bob))
        cur.execute(
            """INSERT INTO agents (id, org_id, owner_id, name, model, visibility) VALUES
               (%s,%s,%s,'alice-private','anthropic/claude-sonnet-4-6','private'),
               (%s,%s,%s,'alice-shared','anthropic/claude-sonnet-4-6','org'),
               (%s,%s,%s,'bob-agent','anthropic/claude-sonnet-4-6','org')""",
            (f.agent_a_private, f.org_a, f.alice,
             f.agent_a_org, f.org_a, f.alice,
             f.agent_b, f.org_b, f.bob))
        cur.execute(
            """INSERT INTO skills (id, org_id, owner_id, slug, name, visibility)
               VALUES (%s,%s,%s,'secret-skill','Secret Skill','private')""",
            (f.skill_a_private, f.org_a, f.alice))
        cur.execute(
            """INSERT INTO skill_versions (id, skill_id, version, checksum, storage_path,
                                           size_bytes, manifest, created_by)
               VALUES (%s,%s,1,'deadbeef','gs://x/y',10,'{}',%s)""",
            (f.skill_a_version, f.skill_a_private, f.alice))
        cur.execute(
            """INSERT INTO mcp_servers (id, org_id, owner_id, name, url, visibility)
               VALUES (%s,%s,%s,'a-mcp','https://mcp.a.test','org')""",
            (f.mcp_a_org, f.org_a, f.alice))
        cur.execute(
            """INSERT INTO mcp_tool_schemas (mcp_server_id, tool_name, input_schema)
               VALUES (%s,'search','{}')""", (f.mcp_a_org,))
        cur.execute(
            """INSERT INTO conversations (id, org_id, user_id, agent_id)
               VALUES (%s,%s,%s,%s)""",
            (f.convo_alice, f.org_a, f.alice, f.agent_a_private))
        cur.execute(
            """INSERT INTO messages (id, conversation_id, org_id, seq, role, content)
               VALUES (%s,%s,%s,1,'user','[{"type":"text","text":"hi"}]')""",
            (f.msg_alice, f.convo_alice, f.org_a))
        conn.commit()
    return f


@pytest.fixture()
def app_conn():
    with psycopg.connect(APP_DSN) as conn:
        yield conn
        conn.rollback()


@contextmanager
def tenant(conn, org_id, user_id):
    """Mirror of the API's tenant_txn: explicit txn + SET LOCAL via set_config."""
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute(
                "SELECT set_config('app.org_id', %s, true), set_config('app.user_id', %s, true)",
                (str(org_id) if org_id else "", str(user_id)),
            )
            yield cur
