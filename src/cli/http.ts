import type { Session } from "./session.js";

export class CliError extends Error {}

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Validates a user-supplied base URL and normalises it to its origin. https only, or http for loopback hosts.
 * Credentials, query and fragment are refused. Errors name the variable only and never echo the value.
 */
export function parseOrigin(name: string, raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new CliError(`${name} is not a valid URL.`);
  }
  if (u.username || u.password) throw new CliError(`${name} must not contain credentials.`);
  if (u.search || u.hash || /[?#]/.test(raw)) throw new CliError(`${name} must not contain a query string or fragment.`);
  const loopback = u.hostname === "localhost" || u.hostname === "[::1]" || LOOPBACK_V4.test(u.hostname);
  if (u.protocol === "https:") return u.origin;
  if (u.protocol === "http:" && loopback) return u.origin;
  throw new CliError(`${name} must use https (http is allowed only for localhost).`);
}

export const REQUEST_TIMEOUT_MS = 15_000;

/** Wraps fetch so no request follows redirects (credentials must not leave the validated host) or hangs forever. */
export function guardedFetch(f: typeof fetch = fetch, timeoutMs = REQUEST_TIMEOUT_MS): typeof fetch {
  return ((input, init) => f(input, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) })) as typeof fetch;
}

const clean = (s: string) => s.replace(/[^\x20-\x7e]/g, " ").slice(0, 200);

/** POST /api/auth/login. `apiUrl` is the validated Mnemonis origin the resulting session is bound to. */
export async function passwordLogin(apiUrl: string, email: string, password: string, f: typeof fetch = guardedFetch()): Promise<Session> {
  let res: Response;
  try {
    res = await f(`${apiUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new CliError(`Cannot reach the Mnemonis server at ${apiUrl}.`);
  }
  let j: { token?: unknown; expiresAt?: unknown; error?: { message?: unknown } } = {};
  try {
    j = (await res.json()) as typeof j;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const msg = typeof j.error?.message === "string" ? j.error.message : undefined;
    throw new CliError(`Login failed (${res.status})${msg ? `: ${clean(msg)}` : ""}`);
  }
  if (typeof j.token !== "string" || typeof j.expiresAt !== "string") throw new CliError("Unexpected response from the login endpoint.");
  return { token: j.token, expiresAt: j.expiresAt, apiUrl };
}

/** Best-effort server-side revocation of this session only. Returns true when the server confirmed it. */
export async function remoteLogout(apiUrl: string, token: string, f: typeof fetch = guardedFetch()): Promise<boolean> {
  try {
    const res = await f(`${apiUrl}/api/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    return res.ok;
  } catch {
    return false;
  }
}
