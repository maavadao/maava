-- Core schema. Conventions: UUIDv7 PKs (app-generated; gen_random_uuid() as a
-- safety default), timestamptz everywhere, soft delete via deleted_at, every
-- tenant-scoped table carries org_id for RLS.

-- ========== Identity & Tenancy ==========
CREATE TABLE orgs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  plan        text NOT NULL DEFAULT 'free',
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       citext UNIQUE NOT NULL,
  name        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TYPE org_role AS ENUM ('owner','admin','member','viewer');

CREATE TABLE memberships (
  org_id      uuid NOT NULL REFERENCES orgs(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  role        org_role NOT NULL DEFAULT 'member',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

-- ========== Agents ==========
CREATE TYPE visibility AS ENUM ('private','org');   -- add 'public' in V3

CREATE TABLE agents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id),
  owner_id      uuid NOT NULL REFERENCES users(id),
  name          text NOT NULL,
  description   text,
  system_prompt text NOT NULL DEFAULT '',
  model         text NOT NULL,                 -- OpenRouter model id
  params        jsonb NOT NULL DEFAULT '{}',
  visibility    visibility NOT NULL DEFAULT 'private',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX ON agents (org_id, visibility) WHERE deleted_at IS NULL;

-- ========== Skills ==========
CREATE TABLE skills (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id),
  owner_id     uuid NOT NULL REFERENCES users(id),
  slug         text NOT NULL,
  name         text NOT NULL,
  description  text,
  visibility   visibility NOT NULL DEFAULT 'private',
  latest_version_id uuid,                      -- FK added after skill_versions
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  UNIQUE (org_id, slug)
);

CREATE TYPE scan_status AS ENUM ('pending','clean','flagged','failed');

CREATE TABLE skill_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id     uuid NOT NULL REFERENCES skills(id),
  version      int  NOT NULL,
  checksum     text NOT NULL,                  -- sha256 of artifact; cache key
  storage_path text NOT NULL,                  -- gs:// object path (immutable)
  size_bytes   bigint NOT NULL,
  manifest     jsonb NOT NULL,                 -- parsed SKILL.md frontmatter
  scan         scan_status NOT NULL DEFAULT 'pending',
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version)
);
ALTER TABLE skills ADD FOREIGN KEY (latest_version_id) REFERENCES skill_versions(id);

-- ========== MCP Servers ==========
CREATE TYPE mcp_auth AS ENUM ('none','bearer','oauth');
CREATE TYPE mcp_health AS ENUM ('unknown','healthy','unreachable','auth_failed');

CREATE TABLE mcp_servers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id),
  owner_id     uuid NOT NULL REFERENCES users(id),
  name         text NOT NULL,
  url          text NOT NULL,                  -- https only; SSRF-validated
  auth_type    mcp_auth NOT NULL DEFAULT 'none',
  secret_ref   text,                           -- Secret Manager resource name; NEVER the credential
  visibility   visibility NOT NULL DEFAULT 'private',
  health       mcp_health NOT NULL DEFAULT 'unknown',
  health_checked_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

CREATE TABLE mcp_tool_schemas (
  mcp_server_id uuid NOT NULL REFERENCES mcp_servers(id),
  tool_name     text NOT NULL,
  description   text,
  input_schema  jsonb NOT NULL,
  refreshed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mcp_server_id, tool_name)
);

-- ========== Agent Attachments ==========
CREATE TABLE agent_skills (
  agent_id         uuid NOT NULL REFERENCES agents(id),
  skill_id         uuid NOT NULL REFERENCES skills(id),
  pinned_version_id uuid REFERENCES skill_versions(id),  -- NULL = track latest
  PRIMARY KEY (agent_id, skill_id)
);

CREATE TABLE agent_mcp (
  agent_id       uuid NOT NULL REFERENCES agents(id),
  mcp_server_id  uuid NOT NULL REFERENCES mcp_servers(id),
  enabled_tools  text[],        -- NULL = all tools enabled; else explicit allowlist
  PRIMARY KEY (agent_id, mcp_server_id)
);

-- ========== Conversations ==========
CREATE TABLE conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  agent_id    uuid NOT NULL REFERENCES agents(id),
  title       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX ON conversations (user_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TYPE msg_role AS ENUM ('user','assistant','system','tool');

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  org_id          uuid NOT NULL,               -- denormalized for RLS
  seq             int  NOT NULL,
  role            msg_role NOT NULL,
  content         jsonb NOT NULL,              -- array of blocks: text | tool_use | tool_result
  model           text,
  token_usage     jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);

CREATE TYPE tool_kind AS ENUM ('skill','mcp','builtin');
CREATE TYPE call_status AS ENUM ('ok','error','denied','timeout');

CREATE TABLE tool_calls (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   uuid NOT NULL REFERENCES messages(id),
  org_id       uuid NOT NULL,
  kind         tool_kind NOT NULL,
  source_id    uuid,                           -- skill_id or mcp_server_id
  tool_name    text NOT NULL,
  input        jsonb NOT NULL,
  output_ref   text,                           -- gs:// path for large outputs
  output       jsonb,
  status       call_status NOT NULL,
  latency_ms   int,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON tool_calls (org_id, created_at DESC);

-- ========== Audit ==========
CREATE TABLE audit_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  actor_id      uuid,
  action        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   uuid,
  meta          jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_events (org_id, created_at DESC);
