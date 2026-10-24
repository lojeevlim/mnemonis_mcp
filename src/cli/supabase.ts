import type { Session } from "./session.js";

export class CliError extends Error {}

export interface AuthConfig {
  supabaseUrl: string;
  anonKey: string;
}

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

const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Allowlist: only a publishable key (sb_publishable_*, case-sensitive) or a well-formed JWT whose role is exactly "anon".
 * Everything else (service_role, authenticated, secret keys, malformed, opaque) is refused. The key is never printed.
 */
export function assertAnonKey(key: string): void {
  const refuse = () => new CliError("SUPABASE_ANON_KEY is not a public anon key. Refusing to use it: set the public anon (publishable) key.");
  if (key.startsWith("sb_publishable_") && key.length > "sb_publishable_".length) return;
  const parts = key.split(".");
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) throw refuse();
  let role: unknown;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
    role = typeof payload === "object" && payload !== null ? (payload as { role?: unknown }).role : undefined;
  } catch {
    throw refuse();
  }
  if (role !== "anon") throw refuse();
}

export const REQUEST_TIMEOUT_MS = 15_000;

/** Wraps fetch so no request follows redirects (tokens must not leave the validated host) or hangs forever. */
export function guardedFetch(f: typeof fetch = fetch, timeoutMs = REQUEST_TIMEOUT_MS): typeof fetch {
  return ((input, init) => f(input, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) })) as typeof fetch;
}

export function authConfig(env: Record<string, string | undefined>): AuthConfig {
  const rawUrl = env.SUPABASE_URL?.trim();
  const anonKey = env.SUPABASE_ANON_KEY?.trim();
  if (!rawUrl) throw new CliError("SUPABASE_URL is not set.");
  const supabaseUrl = parseOrigin("SUPABASE_URL", rawUrl);
  if (!anonKey) throw new CliError("SUPABASE_ANON_KEY is not set (the public anon key).");
  assertAnonKey(anonKey);
  return { supabaseUrl, anonKey };
}

const clean = (s: string) => s.replace(/[^\x20-\x7e]/g, " ").slice(0, 200);

async function tokenGrant(cfg: AuthConfig, apiUrl: string, grant: "password" | "refresh_token", body: Record<string, string>, f: typeof fetch): Promise<Session> {
  let res: Response;
  try {
    res = await f(`${cfg.supabaseUrl}/auth/v1/token?grant_type=${grant}`, {
      method: "POST",
      headers: { apikey: cfg.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new CliError("Cannot reach the Supabase auth endpoint.");
  }
  let j: Record<string, unknown> = {};
  try {
    j = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const msg = [j.error_description, j.msg, j.message].find((m): m is string => typeof m === "string");
    throw new CliError(`Authentication failed (${res.status})${msg ? `: ${clean(msg)}` : ""}`);
  }
  const { access_token, refresh_token } = j;
  if (typeof access_token !== "string" || typeof refresh_token !== "string") throw new CliError("Unexpected response from the auth endpoint.");
  const expires_at =
    typeof j.expires_at === "number" ? j.expires_at : Math.floor(Date.now() / 1000) + (typeof j.expires_in === "number" ? j.expires_in : 3600);
  return { access_token, refresh_token, expires_at, supabaseUrl: cfg.supabaseUrl, apiUrl };
}

/** `apiUrl` is the validated Mnemonis origin the resulting session is bound to. */
export const passwordLogin = (cfg: AuthConfig, apiUrl: string, email: string, password: string, f: typeof fetch = guardedFetch()) =>
  tokenGrant(cfg, apiUrl, "password", { email, password }, f);

export const refreshSession = (cfg: AuthConfig, apiUrl: string, refreshToken: string, f: typeof fetch = guardedFetch()) =>
  tokenGrant(cfg, apiUrl, "refresh_token", { refresh_token: refreshToken }, f);

/** Best-effort remote sign-out of this session only. Returns true when Supabase confirmed it. */
export async function remoteLogout(cfg: AuthConfig, accessToken: string, f: typeof fetch = guardedFetch()): Promise<boolean> {
  try {
    const res = await f(`${cfg.supabaseUrl}/auth/v1/logout?scope=local`, {
      method: "POST",
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${accessToken}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}
