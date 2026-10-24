import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../src/domain/index.js";

describe("vendored domain", () => {
  it("SOURCE.txt records provenance and the same SCHEMA_VERSION", () => {
    const text = readFileSync(new URL("../src/domain/SOURCE.txt", import.meta.url), "utf8");
    expect(text).toMatch(/^commit: [0-9a-f]{40}$/m);
    expect(text).toMatch(/^contentSha256: [0-9a-f]{64}$/m);
    expect(text).toContain(`SCHEMA_VERSION: ${SCHEMA_VERSION}`);
  });
});
