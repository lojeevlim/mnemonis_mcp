// Copies the web repo's pure domain (src/domain) into src/domain and records provenance in SOURCE.txt.
// Usage: npm run sync-domain [-- --web <path-to-web-repo>]   (default ../mnemonis, or MNEMONIS_WEB_REPO)
// Vendored files are NOT edited except that relative imports get a ".js" suffix, which Node ESM needs at
// runtime. The content hash is computed over the ORIGINAL web files, so it is comparable across repos.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argIdx = process.argv.indexOf("--web");
const web = resolve(argIdx > 0 ? process.argv[argIdx + 1] : (process.env.MNEMONIS_WEB_REPO ?? join(root, "..", "mnemonis")));
const srcDir = join(web, "src", "domain");
const outDir = join(root, "src", "domain");

if (!existsSync(srcDir)) {
  console.error(`Web domain not found: ${srcDir}`);
  process.exit(1);
}

const git = (...args) => execFileSync("git", ["-C", web, ...args], { encoding: "utf8" }).trim();
const listFiles = (dir, prefix = "") =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? listFiles(join(dir, e.name), `${prefix}${e.name}/`)
      : /\.(ts|json)$/.test(e.name)
        ? [`${prefix}${e.name}`]
        : [],
  );

const files = listFiles(srcDir).sort();
const hash = createHash("sha256");
for (const f of files) hash.update(`${f}\0`).update(readFileSync(join(srcDir, f))).update("\0");

// Remove previously vendored files so deleted upstream files do not linger.
for (const f of readdirSync(outDir)) rmSync(join(outDir, f), { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const f of files) {
  const dest = join(outDir, f);
  mkdirSync(dirname(dest), { recursive: true });
  if (f.endsWith(".ts")) {
    const text = readFileSync(join(srcDir, f), "utf8").replace(
      /(\bfrom\s+["'])(\.{1,2}\/[^"']*?)(["'])/g,
      (m, a, p, c) => (/\.(js|json)$/.test(p) ? m : `${a}${p}.js${c}`),
    );
    writeFileSync(dest, text);
  } else {
    cpSync(join(srcDir, f), dest);
  }
}

const schemaVersion = /SCHEMA_VERSION\s*=\s*(\d+)/.exec(readFileSync(join(srcDir, "state.ts"), "utf8"))?.[1];
if (!schemaVersion) throw new Error("SCHEMA_VERSION not found in state.ts");
const dirty = git("status", "--porcelain", "--", "src/domain") !== "";
const repoDirty = git("status", "--porcelain") !== "";
writeFileSync(
  join(outDir, "SOURCE.txt"),
  [
    "Vendored from the mnemonis web repo (src/domain). Do not edit by hand; run `npm run sync-domain`.",
    `commit: ${git("rev-parse", "HEAD")}`,
    `domainDirty: ${dirty ? "dirty" : "clean"}`,
    `repoDirty: ${repoDirty ? "dirty" : "clean"}`,
    `contentSha256: ${hash.digest("hex")}`,
    `files: ${files.length}`,
    `SCHEMA_VERSION: ${schemaVersion}`,
    "",
  ].join("\n"),
);
console.log(`Synced ${files.length} files from ${srcDir} (schema ${schemaVersion}${dirty ? ", domain DIRTY" : ""}).`);
