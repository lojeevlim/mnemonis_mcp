import { z } from "zod";

export type SignupMode = "closed" | "allowlist" | "open";

export interface Config {
  databaseUrl: string;
  authIssuer: string;
  authJwksUrl: string;
  authAudience: string;
  authAlgs: string[];
  signupMode: SignupMode;
  /** Lowercased exact emails and "@domain" entries. */
  allowedEmails: string[];
  allowedOrigins: string[];
  allowedHosts: string[];
  trustProxy: boolean;
  autoMigrate: boolean;
  maxMcpTokens: number;
  host: string;
  port: number;
}

/** Thrown for any invalid configuration. Messages name variables only, never their values. */
export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const ALLOWED_ALGS = new Set(["ES256", "ES384", "ES512", "RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "EdDSA"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const list = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const empty = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opt = <T extends z.ZodType>(s: T) => z.preprocess(empty, s.optional());

const schema = z.object({
  DATABASE_URL: z.string().trim().min(1, "is required"),
  SUPABASE_URL: opt(z.string().trim()),
  AUTH_ISSUER: opt(z.string().trim()),
  AUTH_JWKS_URL: opt(z.string().trim()),
  AUTH_AUDIENCE: opt(z.string().trim()),
  AUTH_ALGS: opt(z.string()),
  MNEMONIS_SIGNUP_MODE: z.preprocess(empty, z.enum(["closed", "allowlist", "open"]).default("closed")),
  MNEMONIS_ALLOWED_EMAILS: opt(z.string()),
  MNEMONIS_ALLOWED_ORIGINS: opt(z.string()),
  MNEMONIS_ALLOWED_HOSTS: opt(z.string()),
  MNEMONIS_TRUST_PROXY: z.preprocess(empty, z.enum(["true", "false", "1", "0"]).default("false")),
  MNEMONIS_AUTO_MIGRATE: z.preprocess(empty, z.enum(["true", "false", "1", "0"]).default("false")),
  MNEMONIS_MAX_MCP_TOKENS: z.preprocess(empty, z.coerce.number().int().min(1).max(1000).default(20)),
  HOST: z.preprocess(empty, z.string().trim().default("127.0.0.1")),
  PORT: z.preprocess(empty, z.coerce.number().int().min(0).max(65535).default(8787)),
});

function checkUrl(name: string, value: string, problems: string[]): void {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    problems.push(`${name} is not a valid URL`);
    return;
  }
  if (u.protocol === "https:") return;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return;
  problems.push(`${name} must use https (http is only allowed for loopback hosts)`);
}

/** Parses and validates the environment. Fails fast with a ConfigError that never includes secret values. */
export function parseConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) {
    throw new ConfigError(r.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`));
  }
  const e = r.data;
  const problems: string[] = [];

  let issuer = e.AUTH_ISSUER;
  let jwks = e.AUTH_JWKS_URL;
  let audience = e.AUTH_AUDIENCE;
  if (e.SUPABASE_URL) {
    let base = e.SUPABASE_URL;
    try {
      base = new URL(e.SUPABASE_URL).origin; // drop path/query/fragment/trailing slash
    } catch {
      /* reported by checkUrl */
    }
    checkUrl("SUPABASE_URL", base, problems);
    issuer ??= `${base}/auth/v1`;
    jwks ??= `${issuer}/.well-known/jwks.json`;
    audience ??= "authenticated";
  } else {
    if (!issuer) problems.push("AUTH_ISSUER is required when SUPABASE_URL is not set");
    if (!jwks) problems.push("AUTH_JWKS_URL is required when SUPABASE_URL is not set");
    if (!audience) problems.push("AUTH_AUDIENCE is required when SUPABASE_URL is not set");
  }
  if (issuer && e.AUTH_ISSUER) checkUrl("AUTH_ISSUER", issuer, problems);
  if (jwks && e.AUTH_JWKS_URL) checkUrl("AUTH_JWKS_URL", jwks, problems);

  const algs = e.AUTH_ALGS === undefined ? ["ES256", "RS256", "EdDSA"] : list(e.AUTH_ALGS);
  if (algs.length === 0) problems.push("AUTH_ALGS must list at least one algorithm");
  for (const a of algs) {
    if (!ALLOWED_ALGS.has(a)) problems.push("AUTH_ALGS contains an unsupported algorithm (symmetric HS* and none are refused)");
  }

  const allowedEmails = list(e.MNEMONIS_ALLOWED_EMAILS).map((s) => s.toLowerCase());
  if (allowedEmails.some((a) => !/^[^@\s,]*@[^@\s,]+$/.test(a))) {
    problems.push("MNEMONIS_ALLOWED_EMAILS entries must be local@domain or @domain");
  }
  if (e.MNEMONIS_SIGNUP_MODE === "allowlist" && allowedEmails.length === 0) {
    problems.push("MNEMONIS_ALLOWED_EMAILS is required when MNEMONIS_SIGNUP_MODE=allowlist");
  }

  if (problems.length > 0) throw new ConfigError([...new Set(problems)]);

  return {
    databaseUrl: e.DATABASE_URL,
    authIssuer: issuer!,
    authJwksUrl: jwks!,
    authAudience: audience!,
    authAlgs: algs,
    signupMode: e.MNEMONIS_SIGNUP_MODE,
    allowedEmails,
    allowedOrigins: list(e.MNEMONIS_ALLOWED_ORIGINS),
    allowedHosts: list(e.MNEMONIS_ALLOWED_HOSTS).map((s) => s.toLowerCase()),
    trustProxy: e.MNEMONIS_TRUST_PROXY === "true" || e.MNEMONIS_TRUST_PROXY === "1",
    autoMigrate: e.MNEMONIS_AUTO_MIGRATE === "true" || e.MNEMONIS_AUTO_MIGRATE === "1",
    maxMcpTokens: e.MNEMONIS_MAX_MCP_TOKENS,
    host: e.HOST,
    port: e.PORT,
  };
}
