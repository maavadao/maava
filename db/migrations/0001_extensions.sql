-- Extensions required by the schema.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid() fallback; UUIDv7 is generated app-side
