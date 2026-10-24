import { loadSession, saveSession, type Session } from "./session.js";
import { authConfig, CliError, guardedFetch, parseOrigin, refreshSession } from "./supabase.js";

export interface ClientOptions {
  /** Validated origin (see parseOrigin). */
  apiUrl: string;
  env: Record<string, string | undefined>;
  home?: string;
  fetch?: typeof fetch;
  /** Seconds; injectable for tests. */
  now?: () => number;
}

const LOGIN_HINT = "Session expired or missing. Run: npm run cli -- login";
const REFRESH_SKEW_S = 60;

export const sanitize = (s: string, max = 300): string => s.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ").slice(0, max);

/** Talks to the Mnemonis REST API with the stored Supabase session; refreshes it proactively and once on a 401. */
export class ApiClient {
  private readonly f: typeof fetch;
  private readonly now: () => number;
  constructor(private readonly o: ClientOptions) {
    this.f = o.fetch ?? guardedFetch();
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** The session only ever talks to the hosts that issued it. */
  private assertBound(s: Session): void {
    const raw = this.o.env.SUPABASE_URL?.trim();
    const supabase = raw ? parseOrigin("SUPABASE_URL", raw) : null;
    if (s.apiUrl !== this.o.apiUrl || s.supabaseUrl !== supabase) {
      throw new CliError("The stored session was issued for different SUPABASE_URL / MNEMONIS_API_URL hosts. Run login again.");
    }
  }

  private async refresh(s: Session): Promise<Session> {
    // Another process may have refreshed already (refresh tokens rotate); never replay a spent one.
    const latest = loadSession(this.o.home);
    if (latest && (latest.refresh_token !== s.refresh_token || latest.expires_at !== s.expires_at)) {
      this.assertBound(latest);
      return latest;
    }
    try {
      const next = await refreshSession(authConfig(this.o.env), this.o.apiUrl, s.refresh_token, this.f);
      saveSession(next, this.o.home);
      return next;
    } catch (e) {
      // A bad key/URL config is worth showing as is; any auth failure means the user must log in again.
      if (e instanceof CliError && /SUPABASE_/.test(e.message)) throw e;
      throw new CliError(LOGIN_HINT);
    }
  }

  private async send(method: string, path: string, token: string, body?: unknown): Promise<Response> {
    try {
      return await this.f(`${this.o.apiUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new CliError(`Cannot reach the Mnemonis server at ${this.o.apiUrl}.`);
    }
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let s = loadSession(this.o.home);
    if (!s) throw new CliError(LOGIN_HINT);
    this.assertBound(s);
    if (s.expires_at - this.now() <= REFRESH_SKEW_S) s = await this.refresh(s);
    let res = await this.send(method, path, s.access_token, body);
    if (res.status === 401) {
      s = await this.refresh(s);
      res = await this.send(method, path, s.access_token, body);
      if (res.status === 401) throw new CliError(LOGIN_HINT);
    }
    if (!res.ok) throw await apiError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Unauthenticated health probe. */
  async health(): Promise<unknown> {
    let res: Response;
    try {
      res = await this.f(`${this.o.apiUrl}/api/health`);
    } catch {
      throw new CliError(`Cannot reach the Mnemonis server at ${this.o.apiUrl}.`);
    }
    if (!res.ok) throw await apiError(res);
    return res.json();
  }
}

async function apiError(res: Response): Promise<CliError> {
  try {
    const j = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof j.error?.code === "string" && typeof j.error.message === "string") {
      return new CliError(`${sanitize(j.error.code, 80)}: ${sanitize(j.error.message)}`);
    }
  } catch {
    /* fall through */
  }
  return new CliError(`Request failed (HTTP ${res.status}).`);
}
