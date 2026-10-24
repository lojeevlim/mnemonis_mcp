-- Built-in accounts (no external identity provider): password credentials on users and login sessions.
-- password_hash is nullable so rows created by the earlier identity layer survive (they cannot log in until
-- an operator sets a password). auth_subject is kept as an unused legacy column.
ALTER TABLE users
  ADD COLUMN password_hash       text,
  ADD COLUMN password_updated_at timestamptz,
  ADD COLUMN failed_logins       int NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  ADD COLUMN locked_until        timestamptz;

-- Opaque login sessions for the REST surface only. Only the sha256 of the `ms_` token is stored.
-- expires_at is the ABSOLUTE expiry; idle expiry is derived from last_seen_at.
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   bytea UNIQUE NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  user_agent   text
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

-- Same posture as 0002: RLS on, no policies, anon/authenticated denied.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.sessions FROM %I', r);
    END IF;
  END LOOP;
END
$$;
