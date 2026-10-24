// Vendors the API's contract fixtures (contract/agent-v1/*.json) into contract/agent-v1 and records provenance in SOURCE.txt.
// Usage: node scripts/sync-contract.mjs [--api <path-to-api-repo>] [--check]
//   --api    the mnemonis_api checkout (default ../mnemonis_api, or MNEMONIS_API_REPO)
//   --check  verify only: exit 1 when the vendored files differ from the API's current ones (CI)
// Vendored files are NOT edited. The content hash covers file names and bytes, so it is comparable across checkouts.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const check = process.argv.includes("--check");
const api = resolve(arg("--api") ?? process.env.MNEMONIS_API_REPO ?? join(root, "..", "mnemonis_api"));
const srcDir = join(api, "contract", "agent-v1");
const outDir = join(root, "contract", "agent-v1");

if (!existsSync(srcDir)) {
  console.error(`API contract not found: ${srcDir}`);
  process.exit(1);
}

const files = readdirSync(srcDir).filter((f) => f.endsWith(".json")).sort();
const hash = createHash("sha256");
for (const f of files) hash.update(`${f}\0`).update(readFileSync(join(srcDir, f))).update("\0");
const contentSha256 = hash.digest("hex");

const git = (...args) => {
  try {
    return execFileSync("git", ["-C", api, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
};

if (check) {
  const vendored = existsSync(join(outDir, "SOURCE.txt")) ? readFileSync(join(outDir, "SOURCE.txt"), "utf8") : "";
  const ok = vendored.includes(`contentSha256: ${contentSha256}`) && files.every((f) => existsSync(join(outDir, f)) && readFileSync(join(outDir, f)).equals(readFileSync(join(srcDir, f))));
  if (!ok) {
    console.error("contract/agent-v1 is out of date with the API: run `npm run sync-contract` and commit the result.");
    process.exit(1);
  }
  console.log(`contract/agent-v1 matches the API (${files.length} files, sha256 ${contentSha256.slice(0, 12)}...)`);
  process.exit(0);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const f of files) writeFileSync(join(outDir, f), readFileSync(join(srcDir, f)));
writeFileSync(
  join(outDir, "SOURCE.txt"),
  [
    "Vendored from the mnemonis_api repo (contract/agent-v1). Do not edit by hand; run `npm run sync-contract`.",
    `commit: ${git("rev-parse", "HEAD")}`,
    `contentSha256: ${contentSha256}`,
    `files: ${files.length}`,
    "",
  ].join("\n"),
);
console.log(`Vendored ${files.length} contract files from ${srcDir}`);
