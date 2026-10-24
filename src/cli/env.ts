import { readFileSync } from "node:fs";

/** The only variables the operator CLI ever reads; nothing else from the environment or .env reaches it. */
export const CLI_ENV_KEYS = ["MNEMONIS_API_URL"] as const;

/** Minimal dotenv parser: KEY=VALUE lines, optional `export `, optional matching quotes, `#` comments. No expansion. */
export function parseEnvFile(text: string, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !keys.includes(m[1]!)) continue;
    let v = m[2]!;
    const q = v[0];
    if ((q === '"' || q === "'") && v.length >= 2 && v.endsWith(q)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]!] = v;
  }
  return out;
}

/** Builds the CLI environment from process.env, falling back to `.env` for the allowed keys only. */
export function loadCliEnv(processEnv: NodeJS.ProcessEnv, envFile = ".env"): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const k of CLI_ENV_KEYS) env[k] = processEnv[k];
  if (CLI_ENV_KEYS.every((k) => env[k])) return env;
  let text: string;
  try {
    text = readFileSync(envFile, "utf8");
  } catch {
    return env;
  }
  const fromFile = parseEnvFile(text, CLI_ENV_KEYS);
  for (const k of CLI_ENV_KEYS) if (!env[k] && fromFile[k]) env[k] = fromFile[k];
  return env;
}
