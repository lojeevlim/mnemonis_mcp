import { describe, expect, it } from "vitest";
import { registerExample, startupBanner } from "../src/banner.js";
import { parseConfig } from "../src/config.js";

const cfg = (env: Record<string, string> = {}) => parseConfig({ DATABASE_URL: "postgres://u:p@localhost/x", ...env });

describe("startup banner", () => {
  it("never shows a curl with the password in argv: it is read with read -rs and piped on stdin", () => {
    const text = registerExample(8787).join("\n");
    expect(text).toContain("read -rs PW");
    expect(text).toContain("--data-binary @-");
    expect(text).not.toMatch(/"password":\s*"/);
    expect(text).not.toMatch(/-d\s+'\{[^}]*password/);
    expect(text).not.toMatch(/-d\s+"/);
    expect(text).toContain("/api/auth/register");
  });

  it("the whole banner has no inline-password curl and warns about proxy + TLS on a non-loopback HOST", () => {
    const b = startupBanner(cfg({ HOST: "0.0.0.0", MNEMONIS_ALLOW_REGISTRATION: "false" }), 8787);
    expect(b.lines.join("\n")).not.toMatch(/"password":\s*"<|"password":"/);
    expect(b.warnings.join(" ")).toMatch(/MNEMONIS_TRUST_PROXY is unset/);
    expect(b.warnings.join(" ")).toMatch(/TLS/);
    expect(startupBanner(cfg(), 8787).warnings).toEqual([]);
  });
});
