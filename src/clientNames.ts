import { createHash } from "node:crypto";

export const MAX_CLIENT_NAMES = 1000;
const MAX_NAME = 100;

/** Printable ASCII only, trimmed, at most 100 characters; "" when nothing usable is left (then no header is sent). */
export function sanitizeClientName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[^\x20-\x7e]/g, " ").trim().slice(0, MAX_NAME).trim();
}

/** Inserts into an insertion-ordered map holding at most `max` entries, evicting the oldest (never clearing all). */
export function rememberBounded<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  while (map.size >= max) map.delete(map.keys().next().value as string);
  map.set(key, value);
}

/**
 * MCP clientInfo.name seen at `initialize`, kept per sha256(token) in a bounded in-memory map. The adapter is stateless
 * per request, so this is the only way later tool calls carry the client name. Cosmetic: lost on restart.
 */
export function createClientNames(max = MAX_CLIENT_NAMES) {
  const names = new Map<string, string>();
  const key = (token: string) => createHash("sha256").update(token).digest("hex");
  return {
    remember(token: string, name: string) {
      rememberBounded(names, key(token), name, max);
    },
    get(token: string): string | undefined {
      return names.get(key(token));
    },
    size: () => names.size,
  };
}
export type ClientNames = ReturnType<typeof createClientNames>;
