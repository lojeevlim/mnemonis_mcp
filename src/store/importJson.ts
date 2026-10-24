import { MAX_IMPORT_BYTES, migrateWorkspaceState, type WorkspaceState } from "../domain/index.js";
import { StoreError } from "./types.js";

/** Validates + migrates untrusted import JSON (bare state or `{ state }` envelope). Throws StoreError("corrupt"). */
export function parseImportJson(json: string): WorkspaceState {
  if (json.length > MAX_IMPORT_BYTES) throw new StoreError("corrupt", "Import failed: file is too large");
  // Postgres jsonb/text cannot hold NUL; reject it up front (raw byte or an escaped \u0000 in any key or value).
  if (json.includes("\u0000") || /\\u0000/i.test(json)) throw new StoreError("corrupt", "Import failed: contains NUL characters");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new StoreError("corrupt", "Import failed: not valid JSON");
  }
  const wrapped = (parsed as { state?: unknown } | null)?.state;
  const v = migrateWorkspaceState(wrapped ?? parsed);
  if (!v.ok) throw new StoreError("corrupt", `Import failed: ${v.reason}`);
  return v.state;
}
