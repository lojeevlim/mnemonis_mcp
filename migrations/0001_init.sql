CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL,
  display_name text NOT NULL,
  auth_subject text UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  disabled_at  timestamptz
);

CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

CREATE TABLE api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('mcp', 'web')),
  token_hash   bytea UNIQUE NOT NULL,
  prefix       text,
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX api_tokens_user_id_idx ON api_tokens (user_id);

CREATE TABLE workspaces (
  user_id        uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  rev            bigint NOT NULL DEFAULT 0 CHECK (rev >= 0),
  schema_version int NOT NULL,
  state          jsonb NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  via        text,
  client     text,
  actor_kind text,
  action     text,
  ids        text[],
  ok         boolean,
  code       text
);
CREATE INDEX audit_log_user_at_idx ON audit_log (user_id, at DESC);
