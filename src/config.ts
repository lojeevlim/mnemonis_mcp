import { isIP } from "node:net";
import { z } from "zod";

export interface AdapterConfig {
  /** Base URL of the Mnemonis API (fixed configuration: never derived from a request). */
  apiUrl: string;
  host: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  trustProxy: boolean;
  readTimeoutMs: number;
  writeTimeoutMs: number;
  maxBodyBytes: number;
}

/** Thrown for any invalid configuration. Messages name variables only, never their values. */
export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export const isLoopbackHost = (h: string): boolean => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(h.toLowerCase());

/** True for an IPv4 literal in a private/loopback/link-local range or an IPv6 loopback/ULA/link-local address. */
export function isPrivateHost(h: string): boolean {
  const host = h.replace(/^\[(.*)\]$/, "$1");
  if (isLoopbackHost(host)) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (isIP(host) === 6) return /^(fc|fd|fe80)/i.test(host);
  // A single-label name (docker compose service such as "api") is only resolvable on a private network.
  return !host.includes(".");
}

const list = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const empty = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const bool = z.enum(["true", "false", "1", "0"]);
const isTrue = (v: string | undefined) => v === "true" || v === "1";
const num = (min: number, max: number, def: number) => z.preprocess(empty, z.coerce.number().int().min(min).max(max).default(def));

const schema = z.object({
  MNEMONIS_API_URL: z.preprocess(empty, z.string().trim().default("http://127.0.0.1:8787")),
  MNEMONIS_API_ALLOW_INSECURE_PRIVATE: z.preprocess(empty, bool.default("false")),
  MCP_HOST: z.preprocess(empty, z.string().trim().default("127.0.0.1")),
  MCP_PORT: num(0, 65535, 8788),
  MNEMONIS_ALLOWED_HOSTS: z.preprocess(empty, z.string().optional()),
  MNEMONIS_ALLOWED_ORIGINS: z.preprocess(empty, z.string().optional()),
  MNEMONIS_TRUST_PROXY: z.preprocess(empty, bool.default("false")),
  MNEMONIS_UPSTREAM_READ_TIMEOUT_MS: num(100, 120_000, 10_000),
  MNEMONIS_UPSTREAM_WRITE_TIMEOUT_MS: num(100, 120_000, 20_000),
  MNEMONIS_MAX_BODY_BYTES: num(1024, 64 * 1024 * 1024, 1024 * 1024),
});

/** The API URL: https, or http on loopback (or on a private network when MNEMONIS_API_ALLOW_INSECURE_PRIVATE=true); no credentials, query or fragment. */
export function validApiUrl(v: string, allowInsecurePrivate: boolean): boolean {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && (isLoopbackHost(u.hostname) || (allowInsecurePrivate && isPrivateHost(u.hostname)));
}

/** Parses and validates the environment (no database settings, no secrets). Fails fast with a ConfigError that never includes values. */
export function parseConfig(env: Record<string, string | undefined> = process.env): AdapterConfig {
  const r = schema.safeParse(env);
  if (!r.success) throw new ConfigError(r.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`));
  const e = r.data;
  const problems: string[] = [];
  if (!validApiUrl(e.MNEMONIS_API_URL, isTrue(e.MNEMONIS_API_ALLOW_INSECURE_PRIVATE))) {
    problems.push(
      "MNEMONIS_API_URL must be https (or http on localhost; http on a private network needs MNEMONIS_API_ALLOW_INSECURE_PRIVATE=true) without credentials, query or fragment",
    );
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return {
    apiUrl: e.MNEMONIS_API_URL.replace(/\/+$/, ""),
    host: e.MCP_HOST,
    port: e.MCP_PORT,
    allowedHosts: list(e.MNEMONIS_ALLOWED_HOSTS).map((s) => s.toLowerCase()),
    allowedOrigins: list(e.MNEMONIS_ALLOWED_ORIGINS).map((s) => s.replace(/\/+$/, "")),
    trustProxy: isTrue(e.MNEMONIS_TRUST_PROXY),
    readTimeoutMs: e.MNEMONIS_UPSTREAM_READ_TIMEOUT_MS,
    writeTimeoutMs: e.MNEMONIS_UPSTREAM_WRITE_TIMEOUT_MS,
    maxBodyBytes: e.MNEMONIS_MAX_BODY_BYTES,
  };
}
