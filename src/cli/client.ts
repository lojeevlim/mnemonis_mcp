import { CliError, guardedFetch } from "./http.js";
import { loadSession, type Session } from "./session.js";

export interface ClientOptions {
  /** Validated origin (see parseOrigin). */
  apiUrl: string;
  home?: string;
  fetch?: typeof fetch;
}

const LOGIN_HINT = "Session expired or missing. Run: npm run cli -- login";

export const sanitize = (s: string, max = 300): string => s.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ").slice(0, max);

/** Talks to the Mnemonis REST API with the stored login session (Authorization: Bearer ms_...). */
export class ApiClient {
  private readonly f: typeof fetch;
  constructor(private readonly o: ClientOptions) {
    this.f = o.fetch ?? guardedFetch();
  }

  /** The session only ever talks to the host that issued it. */
  private assertBound(s: Session): void {
    if (s.apiUrl !== this.o.apiUrl) throw new CliError("The stored session was issued for a different MNEMONIS_API_URL. Run login again.");
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
    const s = loadSession(this.o.home);
    if (!s) throw new CliError(LOGIN_HINT);
    this.assertBound(s);
    const res = await this.send(method, path, s.token, body);
    if (res.status === 401) throw new CliError(LOGIN_HINT);
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
