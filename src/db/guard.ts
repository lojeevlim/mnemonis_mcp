/** Hosts that count as "this machine": a local Docker/dev Postgres. Anything else is a remote database. */
const LOCAL_DB_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const ALLOW_REMOTE_DB_VAR = "MNEMONIS_ALLOW_REMOTE_DB";

/** Thrown when a connection string points at a remote database without the explicit opt-in. Never contains the URL. */
export class RemoteDatabaseError extends Error {
  constructor(what: string, reason: string) {
    super(`${what} ${reason}. Set ${ALLOW_REMOTE_DB_VAR}=true to use a remote database deliberately.`);
    this.name = "RemoteDatabaseError";
  }
}

/** Marker for a URL with no host at all (postgres:///db): the driver then takes the host from PGHOST. */
const DEFAULT_HOST = "\0default";

/** Hostname of a postgres:// URL, or null when the URL cannot be parsed. "" means an explicit unix socket path; DEFAULT_HOST means no host in the URL. */
function hostOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return null;
    const socket = u.searchParams.get("host");
    return socket !== null && socket !== "" ? (socket.startsWith("/") ? "" : socket.toLowerCase()) : u.hostname.toLowerCase() || DEFAULT_HOST;
  } catch {
    return null;
  }
}

/**
 * Refuses a database URL whose host is not localhost/127.0.0.1/::1 (or a unix socket) unless MNEMONIS_ALLOW_REMOTE_DB=true.
 * This keeps a stray remote DATABASE_URL (for example in a developer's .env) from being migrated or written to by accident.
 * Messages name the variable only, never the URL.
 */
export function assertDatabaseHostAllowed(url: string, env: Record<string, string | undefined> = process.env, what = "DATABASE_URL"): void {
  const allow = env[ALLOW_REMOTE_DB_VAR];
  if (allow === "true" || allow === "1") return;
  const host = hostOf(url);
  if (host === null) throw new RemoteDatabaseError(what, "is not a valid postgres:// URL, so its host cannot be checked");
  if (host === "" || LOCAL_DB_HOSTS.has(host)) return;
  if (host === DEFAULT_HOST) {
    // No host in the URL: pg falls back to PGHOST, so a remote PGHOST must not slip through (unset/socket = local default).
    const pgHost = (env.PGHOST ?? "").trim();
    const remote = pgHost.split(",").map((h) => h.trim().toLowerCase()).filter((h) => h !== "" && !h.startsWith("/") && !LOCAL_DB_HOSTS.has(h));
    if (remote.length === 0) return;
    throw new RemoteDatabaseError(what, "has no host and PGHOST points at a non-local database host (only localhost, 127.0.0.1 and ::1 are accepted by default)");
  }
  throw new RemoteDatabaseError(what, "points at a non-local database host (only localhost, 127.0.0.1 and ::1 are accepted by default)");
}
