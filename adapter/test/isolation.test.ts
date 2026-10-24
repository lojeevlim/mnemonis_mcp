import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith(".ts") ? [join(dir, f)] : []));

describe("the adapter holds no database access and no domain logic", () => {
  it("imports nothing from the API (src/**), pg, jose or a domain", () => {
    const bad: string[] = [];
    for (const f of files(SRC)) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        const spec = m[1]!;
        const outside = spec.startsWith(".") && !join(dirname(f), spec).startsWith(SRC);
        if (outside || /^(pg|jose|@types\/pg)(\/|$)/.test(spec) || /\/domain\//.test(spec) || /\/(store|service|db|auth)\//.test(spec)) bad.push(`${relative(SRC, f)} -> ${spec}`);
      }
      expect(text, relative(SRC, f)).not.toMatch(/DATABASE_URL|process\.env\.(SUPABASE|JWT)/);
    }
    expect(bad).toEqual([]);
  });
});
