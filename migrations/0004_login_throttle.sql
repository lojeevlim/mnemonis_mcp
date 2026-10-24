-- Login throttling that survives restarts and cannot be used to lock a victim out for good.
--
-- login_throttle: one row per throttle key. The key is a sha256 hex digest, so the table never holds an email or an IP
-- in the clear, and it is the SAME structure for known and unknown emails (no existence signal, also after a restart).
--   scope 'email'    : soft lock on the email alone (short, capped); bypassed by a correct password from a known-good IP
--   scope 'email_ip' : strict lock on (email, IP bucket); 60 s doubling to 900 s
--   scope 'reauth'   : backoff for change-password / delete-account re-authentication, per user id
-- Rows expire (expires_at) and are reaped by a bounded periodic job; the table is also capped by that job.
CREATE TABLE login_throttle (
  key          text PRIMARY KEY,
  scope        text NOT NULL CHECK (scope IN ('email', 'email_ip', 'reauth')),
  subject      text NOT NULL,
  failures     int NOT NULL DEFAULT 0 CHECK (failures >= 0),
  locked_until timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX login_throttle_subject_idx ON login_throttle (subject);
CREATE INDEX login_throttle_expires_idx ON login_throttle (expires_at);

-- Known-good (user, IP bucket) pairs from successful logins: ip_hash = sha256 of a per-user-salted IP bucket (IPv6 /64).
-- A correct password from such a bucket is never refused by the soft email lock. Bounded per user and by a 30-day TTL.
CREATE TABLE known_login_ips (
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  ip_hash         bytea NOT NULL,
  last_success_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ip_hash)
);
CREATE INDEX known_login_ips_seen_idx ON known_login_ips (last_success_at);

-- Reaping sessions scans these.
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
CREATE INDEX sessions_revoked_at_idx ON sessions (revoked_at) WHERE revoked_at IS NOT NULL;

-- The per-user counters of migration 0003 are superseded by login_throttle; clear any stale lock so it cannot linger.
UPDATE users SET failed_logins = 0, locked_until = NULL WHERE failed_logins <> 0 OR locked_until IS NOT NULL;

ALTER TABLE login_throttle ENABLE ROW LEVEL SECURITY;
ALTER TABLE known_login_ips ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  t text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['login_throttle', 'known_login_ips'] LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END LOOP;
    END IF;
  END LOOP;
END
$$;
