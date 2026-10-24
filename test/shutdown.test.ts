import { describe, expect, it } from "vitest";
import { shutdown } from "../src/shutdown.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("shutdown ordering", () => {
  it("drains the server, THEN flushes audit, THEN ends the pool", async () => {
    const log: string[] = [];
    await shutdown({
      server: { close: async () => { log.push("close:start"); await sleep(30); log.push("close:end"); } },
      audit: { flush: async () => { log.push("flush"); } },
      pool: { end: async () => { log.push("pool"); } },
    });
    expect(log).toEqual(["close:start", "close:end", "flush", "pool"]);
  });

  it("passes the grace period to the server and bounds a hung drain / flush", async () => {
    const log: string[] = [];
    let grace: number | undefined;
    const started = Date.now();
    await shutdown(
      {
        server: { close: (g) => ((grace = g), new Promise(() => undefined)) }, // never resolves
        audit: { flush: () => new Promise(() => undefined) }, // never resolves
        pool: { end: async () => { log.push("pool"); } },
      },
      { graceMs: 20, flushMs: 20 },
    );
    expect(grace).toBe(20);
    expect(log).toEqual(["pool"]);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
