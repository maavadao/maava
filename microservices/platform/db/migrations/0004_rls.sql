-- Row-Level Security. Tenant context is set per-transaction by the API:
--   SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true);
-- (set_config(..., true) == SET LOCAL — mandatory with transaction pooling.)
--
-- current_setting(..., true) returns NULL when unset (NULLIF handles the
-- empty-string case from signup bootstrap), so every policy fails closed:
-- no context => no rows.

-- ---------- helpers ----------
CREATE FUNCTION app_org_id() RETURNS uuid
  LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;

CREATE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- SECURITY DEFINER so it can read memberships regardless of RLS; owned by the
-- migration role (which has no BYPASSRLS concerns here — it is the table owner).
CREATE FUNCTION app_current_role() RETURNS org_role
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT role FROM memberships
    WHERE org_id = app_org_id() AND user_id = app_user_id()
  $$;

CREATE FUNCTION app_is_admin() RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT app_current_role() IN ('owner','admin') $$;

REVOKE ALL ON FUNCTION app_current_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_current_role() TO app_api;

-- Signup bootstrap: create an org and its owner membership atomically for the
-- current user, before any org context exists.
CREATE FUNCTION create_org_with_owner(p_name text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  DECLARE v_org uuid;
  BEGIN
    IF app_user_id() IS NULL THEN
      RAISE EXCEPTION 'app.user_id not set';
    END IF;
    INSERT INTO orgs (name) VALUES (p_name) RETURNING id INTO v_org;
    INSERT INTO memberships (org_id, user_id, role) VALUES (v_org, app_user_id(), 'owner');
    RETURN v_org;
  END $$;
REVOKE ALL ON FUNCTION create_org_with_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_org_with_owner(text) TO app_api;

-- ---------- orgs ----------
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
CREATE POLICY orgs_read ON orgs FOR SELECT
  USING (id = app_org_id() AND deleted_at IS NULL);
CREATE POLICY orgs_update ON orgs FOR UPDATE
  USING (id = app_org_id() AND app_current_role() = 'owner')
  WITH CHECK (id = app_org_id());

-- ---------- users ----------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_read ON users FOR SELECT
  USING (deleted_at IS NULL
         AND (id = app_user_id()
              OR EXISTS (SELECT 1 FROM memberships m
                         WHERE m.user_id = users.id AND m.org_id = app_org_id())));
CREATE POLICY users_insert ON users FOR INSERT
  WITH CHECK (id = app_user_id());        -- signup: context set to the new user id
CREATE POLICY users_update ON users FOR UPDATE
  USING (id = app_user_id()) WITH CHECK (id = app_user_id());

-- ---------- memberships ----------
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_read ON memberships FOR SELECT
  USING (org_id = app_org_id() OR user_id = app_user_id());
CREATE POLICY memberships_write ON memberships FOR INSERT
  WITH CHECK (org_id = app_org_id() AND app_is_admin());
CREATE POLICY memberships_update ON memberships FOR UPDATE
  USING (org_id = app_org_id() AND app_is_admin())
  WITH CHECK (org_id = app_org_id());

-- ---------- agents ----------
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY agents_read ON agents FOR SELECT
  USING (org_id = app_org_id() AND deleted_at IS NULL
         AND (visibility = 'org' OR owner_id = app_user_id()));
CREATE POLICY agents_insert ON agents FOR INSERT
  WITH CHECK (org_id = app_org_id() AND owner_id = app_user_id());
CREATE POLICY agents_update ON agents FOR UPDATE
  USING (org_id = app_org_id()
         AND (owner_id = app_user_id() OR (app_is_admin() AND visibility = 'org')))
  WITH CHECK (org_id = app_org_id());

-- ---------- skills ----------
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY skills_read ON skills FOR SELECT
  USING (org_id = app_org_id() AND deleted_at IS NULL
         AND (visibility = 'org' OR owner_id = app_user_id()));
CREATE POLICY skills_insert ON skills FOR INSERT
  WITH CHECK (org_id = app_org_id() AND owner_id = app_user_id());
CREATE POLICY skills_update ON skills FOR UPDATE
  USING (org_id = app_org_id()
         AND (owner_id = app_user_id() OR (app_is_admin() AND visibility = 'org')))
  WITH CHECK (org_id = app_org_id());

-- ---------- skill_versions (no org_id: scoped through the parent skill,
-- whose own RLS applies inside the EXISTS) ----------
ALTER TABLE skill_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY skill_versions_read ON skill_versions FOR SELECT
  USING (EXISTS (SELECT 1 FROM skills s WHERE s.id = skill_id));
CREATE POLICY skill_versions_insert ON skill_versions FOR INSERT
  WITH CHECK (created_by = app_user_id()
              AND EXISTS (SELECT 1 FROM skills s
                          WHERE s.id = skill_id
                            AND (s.owner_id = app_user_id()
                                 OR (app_is_admin() AND s.visibility = 'org'))));
CREATE POLICY skill_versions_update ON skill_versions FOR UPDATE
  USING (EXISTS (SELECT 1 FROM skills s
                 WHERE s.id = skill_id
                   AND (s.owner_id = app_user_id()
                        OR (app_is_admin() AND s.visibility = 'org'))));

-- ---------- mcp_servers ----------
ALTER TABLE mcp_servers ENABLE ROW LEVEL SECURITY;
CREATE POLICY mcp_servers_read ON mcp_servers FOR SELECT
  USING (org_id = app_org_id() AND deleted_at IS NULL
         AND (visibility = 'org' OR owner_id = app_user_id()));
CREATE POLICY mcp_servers_insert ON mcp_servers FOR INSERT
  WITH CHECK (org_id = app_org_id() AND owner_id = app_user_id());
CREATE POLICY mcp_servers_update ON mcp_servers FOR UPDATE
  USING (org_id = app_org_id()
         AND (owner_id = app_user_id() OR (app_is_admin() AND visibility = 'org')))
  WITH CHECK (org_id = app_org_id());

-- ---------- mcp_tool_schemas ----------
ALTER TABLE mcp_tool_schemas ENABLE ROW LEVEL SECURITY;
CREATE POLICY mcp_tool_schemas_read ON mcp_tool_schemas FOR SELECT
  USING (EXISTS (SELECT 1 FROM mcp_servers s WHERE s.id = mcp_server_id));
CREATE POLICY mcp_tool_schemas_write ON mcp_tool_schemas FOR ALL
  USING (EXISTS (SELECT 1 FROM mcp_servers s
                 WHERE s.id = mcp_server_id
                   AND (s.owner_id = app_user_id()
                        OR (app_is_admin() AND s.visibility = 'org'))))
  WITH CHECK (EXISTS (SELECT 1 FROM mcp_servers s
                      WHERE s.id = mcp_server_id
                        AND (s.owner_id = app_user_id()
                             OR (app_is_admin() AND s.visibility = 'org'))));

-- ---------- agent attachments ----------
ALTER TABLE agent_skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_skills_read ON agent_skills FOR SELECT
  USING (EXISTS (SELECT 1 FROM agents a WHERE a.id = agent_id));
CREATE POLICY agent_skills_write ON agent_skills FOR ALL
  USING (EXISTS (SELECT 1 FROM agents a
                 WHERE a.id = agent_id
                   AND (a.owner_id = app_user_id()
                        OR (app_is_admin() AND a.visibility = 'org'))))
  WITH CHECK (EXISTS (SELECT 1 FROM agents a
                      WHERE a.id = agent_id
                        AND (a.owner_id = app_user_id()
                             OR (app_is_admin() AND a.visibility = 'org'))));

ALTER TABLE agent_mcp ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_mcp_read ON agent_mcp FOR SELECT
  USING (EXISTS (SELECT 1 FROM agents a WHERE a.id = agent_id));
CREATE POLICY agent_mcp_write ON agent_mcp FOR ALL
  USING (EXISTS (SELECT 1 FROM agents a
                 WHERE a.id = agent_id
                   AND (a.owner_id = app_user_id()
                        OR (app_is_admin() AND a.visibility = 'org'))))
  WITH CHECK (EXISTS (SELECT 1 FROM agents a
                      WHERE a.id = agent_id
                        AND (a.owner_id = app_user_id()
                             OR (app_is_admin() AND a.visibility = 'org'))));

-- ---------- conversations (strictly per-user, even inside an org) ----------
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversations_rw ON conversations FOR ALL
  USING (org_id = app_org_id() AND user_id = app_user_id() AND deleted_at IS NULL)
  WITH CHECK (org_id = app_org_id() AND user_id = app_user_id());

-- ---------- messages (append-only; visibility follows the conversation) ----------
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_read ON messages FOR SELECT
  USING (org_id = app_org_id()
         AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_id));
CREATE POLICY messages_insert ON messages FOR INSERT
  WITH CHECK (org_id = app_org_id()
              AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_id));

-- ---------- tool_calls (append-only; visibility follows the message) ----------
ALTER TABLE tool_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY tool_calls_read ON tool_calls FOR SELECT
  USING (org_id = app_org_id()
         AND EXISTS (SELECT 1 FROM messages m WHERE m.id = message_id));
CREATE POLICY tool_calls_insert ON tool_calls FOR INSERT
  WITH CHECK (org_id = app_org_id()
              AND EXISTS (SELECT 1 FROM messages m WHERE m.id = message_id));

-- ---------- audit_events (write: anyone in org; read: owner/admin only) ----------
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_events FOR SELECT
  USING (org_id = app_org_id() AND app_is_admin());
CREATE POLICY audit_insert ON audit_events FOR INSERT
  WITH CHECK (org_id = app_org_id());
