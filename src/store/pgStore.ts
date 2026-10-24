import type pg from "pg";
import { createEmptyWorkspace, migrateWorkspaceState, SCHEMA_VERSION, type Mutation, type WorkspaceState } from "../domain/index.js";
import { parseImportJson } from "./importJson.js";
import { assertWithinQuota, DEFAULT_QUOTAS, type Quotas } from "./quota.js";
import { StoreError, type Snapshot, type UserStore, type WorkspaceStore } from "./types.js";

interface Row {
  rev: string | number;
  state: unknown;
}

function toSnapshot(row: Row): Snapshot {
  const rev = Number(row.rev);
  const v = migrateWorkspaceState(row.state);
  if (!Number.isSafeInteger(rev) || !v.ok) throw new StoreError("corrupt", "Stored workspace is unreadable");
  return { rev, state: v.state };
}

/** Driver errors can carry SQL, parameters or hosts; callers only ever see a generic StoreError. */
function wrapDb(e: unknown): never {
  if (e instanceof StoreError) throw e;
  const code = (e as { code?: unknown } | null)?.code;
  // NUL characters (22P05 untranslatable, 22021 invalid byte sequence) are bad input, not an outage.
  if (code === "22P05" || code === "22021") throw new StoreError("corrupt", "Data contains characters that cannot be stored");
  throw new StoreError("io", "Database error");
}

/** True when the connection itself is suspect: not a server SQLSTATE (e.g. ECONNRESET), class 08, or 57P (shutdown). */
function isConnectionError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return e instanceof Error && !(e instanceof StoreError) && !(e instanceof CallerError) && /connection|socket|terminated/i.test(e.message);
  return !/^[0-9A-Z]{5}$/.test(code) || code.startsWith("08") || code.startsWith("57P");
}

/** Carries an error thrown by the caller's own function through the driver-error wrapping unchanged. */
class CallerError {
  constructor(readonly cause: unknown) {}
}

/**
 * PostgreSQL workspace store: one jsonb workspace row per user (workspaces table). The user id is bound once in
 * forUser() and only ever sent as a query parameter. Writes lock the row (SELECT ... FOR UPDATE), so concurrent
 * transactions on one user serialize across processes; different users never contend.
 */
export class PgStore implements WorkspaceStore {
  private readonly quotas: Quotas;

  /** `quotas` are per-user caps enforced on every write path (ops, import, MCP writes, operator import). */
  constructor(
    private readonly pool: pg.Pool,
    quotas: Partial<Quotas> = {},
  ) {
    this.quotas = { ...DEFAULT_QUOTAS, ...quotas };
  }

  forUser(userId: string): UserStore {
    return new PgUserStore(this.pool, userId, this.quotas);
  }

  /** Creates the user's empty workspace if it does not exist yet (idempotent). */
  async ensureWorkspace(userId: string): Promise<void> {
    try {
      await this.pool.query(
        "INSERT INTO workspaces (user_id, rev, schema_version, state) VALUES ($1, 0, $2, $3::jsonb) ON CONFLICT (user_id) DO NOTHING",
        [userId, SCHEMA_VERSION, JSON.stringify(createEmptyWorkspace())],
      );
    } catch (e) {
      wrapDb(e);
    }
  }
}

class PgUserStore implements UserStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly userId: string,
    private readonly quotas: Quotas,
  ) {}

  async read(): Promise<Snapshot> {
    let row: Row | undefined;
    try {
      row = (await this.pool.query<Row>("SELECT rev, state FROM workspaces WHERE user_id = $1", [this.userId])).rows[0];
    } catch (e) {
      wrapDb(e);
    }
    if (!row) throw new StoreError("io", "Workspace not found");
    return toSnapshot(row);
  }

  transact<T>(fn: (state: WorkspaceState) => Mutation<T>): Promise<Snapshot & { value: T }> {
    return this.locked(async (client, current) => {
      let result: Mutation<T>;
      try {
        result = fn(current.state);
      } catch (e) {
        throw new CallerError(e); // rolls back, rethrown as-is
      }
      if (result.state === current.state) return { ...current, value: result.value };
      return { ...(await this.update(client, result.state, current)), value: result.value };
    });
  }

  replace(json: string, opts: { ifMatchRev?: number } = {}): Promise<Snapshot> {
    return this.locked(async (client, current) => {
      if (opts.ifMatchRev !== undefined && opts.ifMatchRev !== current.rev) {
        throw new StoreError("conflict", `Revision mismatch (current ${current.rev})`);
      }
      return this.update(client, parseImportJson(json), current);
    });
  }

  async write(state: WorkspaceState): Promise<Snapshot> {
    return this.locked((client, current) => this.update(client, state, current));
  }

  /** BEGIN; lock + load the row; run `body`; COMMIT. Any throw ROLLBACKs. Anything that is not a StoreError or the caller's own error becomes io. */
  private async locked<R>(body: (client: pg.PoolClient, current: Snapshot) => Promise<R>): Promise<R> {
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (e) {
      return wrapDb(e);
    }
    let inTx = false;
    let destroy = false;
    try {
      await client.query("BEGIN");
      inTx = true;
      const row = (await client.query<Row>("SELECT rev, state FROM workspaces WHERE user_id = $1 FOR UPDATE", [this.userId])).rows[0];
      if (!row) throw new StoreError("io", "Workspace not found");
      const out = await body(client, toSnapshot(row));
      await client.query("COMMIT");
      inTx = false;
      return out;
    } catch (e) {
      if (isConnectionError(e)) destroy = true;
      if (inTx) await client.query("ROLLBACK").catch(() => (destroy = true));
      if (e instanceof CallerError) throw e.cause;
      return wrapDb(e);
    } finally {
      client.release(destroy);
    }
  }

  private async update(client: pg.PoolClient, state: WorkspaceState, current: Snapshot): Promise<Snapshot> {
    const json = JSON.stringify(state);
    assertWithinQuota(json, state, () => ({ json: JSON.stringify(current.state), memories: Object.keys(current.state.memories).length }), this.quotas);
    const row = (
      await client.query<Row>(
        "UPDATE workspaces SET rev = rev + 1, schema_version = $2, state = $3::jsonb, updated_at = now() WHERE user_id = $1 RETURNING rev, state",
        [this.userId, SCHEMA_VERSION, json],
      )
    ).rows[0];
    if (!row) throw new StoreError("io", "Workspace not found");
    return { rev: Number(row.rev), state };
  }
}
