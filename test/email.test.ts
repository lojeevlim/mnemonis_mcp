import { describe, expect, it } from "vitest";
import { normalizeAllowEntry, normalizeEmail } from "../src/auth/email.js";

describe("normalizeEmail", () => {
  it("applies NFKC, trim and lowercase", () => {
    expect(normalizeEmail("  Alice@Example.COM ")).toBe("alice@example.com");
    expect(normalizeEmail("Ａｌｉｃｅ@ｅｘａｍｐｌｅ.com")).toBe("alice@example.com"); // fullwidth
    expect(normalizeEmail("aK@example.com")).toBe("ak@example.com"); // Kelvin sign
    expect(normalizeEmail("ﬁ@example.com")).toBe("fi@example.com"); // ligature
  });

  it("requires local@domain with a dotted domain", () => {
    for (const ok of ["a@b.co", "first.last+tag@sub.example.org"]) expect(normalizeEmail(ok), ok).toBe(ok);
    for (const bad of ["a@b", "a@localhost", "a@.com", "a@com.", "a@b..c", "@example.com", "a@", "a b@example.com", "a@b@c.com", "", "   ", "a@exa mple.com"]) expect(normalizeEmail(bad), bad).toBeNull();
  });

  it("refuses control, bidi and zero-width characters, non-strings and over-long values", () => {
    for (const bad of ["a\u0000@example.com", "a‮@example.com", "a​@example.com", "a\n@example.com", 5, null, undefined, {}, `${"a".repeat(250)}@example.com`]) {
      expect(normalizeEmail(bad), String(bad)).toBeNull();
    }
  });

  it("normalizeAllowEntry uses the same case/Unicode folding", () => {
    expect(normalizeAllowEntry(" @Ｅxample.COM ")).toBe("@example.com");
  });
});
