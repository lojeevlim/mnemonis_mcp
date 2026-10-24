import { randomUUID } from "node:crypto";
import type { Upstream } from "./upstream/client.js";
import { TOOL_NAMES } from "./mcp/schemas.js";

/** Contract versions of /api/agent/* this adapter can speak (bump together with the vendored contract/agent-v1). */
export const SUPPORTED_CONTRACTS: readonly number[] = [1];

export type ContractState = { status: "unknown" } | { status: "ok"; version: number } | { status: "mismatch"; reason: string };

/** Pure compatibility check of the API's public GET /api/agent/contract body. */
export function checkContract(body: unknown): ContractState {
  const b = body as { contract?: unknown; version?: unknown; minSupported?: unknown; tools?: unknown } | null;
  if (!b || b.contract !== "mnemonis-agent" || typeof b.version !== "number" || typeof b.minSupported !== "number" || !Array.isArray(b.tools)) {
    return { status: "mismatch", reason: "not a Mnemonis agent contract" };
  }
  const usable = SUPPORTED_CONTRACTS.filter((v) => v >= (b.minSupported as number) && v <= (b.version as number));
  if (usable.length === 0) return { status: "mismatch", reason: `API speaks contract ${b.minSupported}..${b.version}, adapter supports ${SUPPORTED_CONTRACTS.join(",")}` };
  const missing = TOOL_NAMES.filter((n) => !(b.tools as unknown[]).includes(n));
  if (missing.length > 0) return { status: "mismatch", reason: `API lacks tools: ${missing.join(", ")}` };
  return { status: "ok", version: Math.max(...usable) };
}

export interface ContractWatcher {
  state(): ContractState;
  /** Resolves once the contract is confirmed OR found incompatible (never rejects). */
  settled(): Promise<ContractState>;
  stop(): void;
}

/** Checks the API contract at startup and keeps retrying with backoff while the API is unreachable (never crashes). */
export function watchContract(upstream: Upstream, opts: { log?: (line: string) => void; minDelayMs?: number; maxDelayMs?: number } = {}): ContractWatcher {
  const { log = () => undefined, minDelayMs = 1000, maxDelayMs = 30_000 } = opts;
  let state: ContractState = { status: "unknown" };
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveSettled!: (s: ContractState) => void;
  const settled = new Promise<ContractState>((r) => (resolveSettled = r));

  const attempt = async (delay: number): Promise<void> => {
    if (stopped) return;
    const r = await upstream.request({ method: "GET", path: "/api/agent/contract", headers: { requestId: randomUUID() }, kind: "read" });
    if (stopped) return;
    if (r.kind === "ok") {
      state = checkContract(r.body);
      if (state.status === "mismatch") log(`contract mismatch: ${state.reason}`);
      else log(`API contract confirmed (version ${(state as { version: number }).version})`);
      resolveSettled(state);
      return;
    }
    log("API not reachable yet; retrying");
    timer = setTimeout(() => void attempt(Math.min(delay * 2, maxDelayMs)), delay);
    timer.unref();
  };
  void attempt(minDelayMs);

  return {
    state: () => state,
    settled: () => settled,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
