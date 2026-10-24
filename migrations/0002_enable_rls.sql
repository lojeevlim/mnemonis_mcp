-- Defence in depth for hosted Postgres (Supabase): tables in `public` are reachable through the Data API
-- by anyone holding the public anon key unless Row-Level Security is on. Enable RLS with NO policies, so
-- anon/authenticated are denied by default. The server connects as the table owner, which bypasses RLS
-- (we deliberately do NOT use FORCE ROW LEVEL SECURITY: with no policies it would lock out the owner too).
-- Idempotent and safe on plain Postgres where the anon/authenticated roles do not exist.
ALTER TABLE users             ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces        ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_tokens        ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  t text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['users', 'workspaces', 'api_tokens', 'audit_log', 'schema_migrations'] LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END LOOP;
      EXECUTE format('REVOKE ALL ON SEQUENCE public.audit_log_id_seq FROM %I', r);
    END IF;
  END LOOP;
END
$$;
