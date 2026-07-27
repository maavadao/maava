-- Application role: no BYPASSRLS, no DDL, no superuser. The API connects only
-- as this role. Password is set out-of-band (Secret Manager in prod, docker
-- env locally) — never in a migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_api') THEN
    CREATE ROLE app_api LOGIN PASSWORD 'app_api_dev_only';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_api;

-- Soft-delete tables: app may never hard-DELETE (janitor/GDPR jobs run as a
-- separate maintenance role).
GRANT SELECT, INSERT, UPDATE ON orgs, users, memberships, agents, skills,
  skill_versions, mcp_servers, conversations TO app_api;

-- Attachments are plain rows, hard-deleted on detach.
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_skills, agent_mcp TO app_api;

-- Tool schema cache is fully rewritten on refresh.
GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_tool_schemas TO app_api;

-- Append-only: no UPDATE/DELETE on messages, tool_calls, audit_events.
GRANT SELECT, INSERT ON messages, tool_calls, audit_events TO app_api;
