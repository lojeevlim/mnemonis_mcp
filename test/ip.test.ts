import { describe, expect, it } from "vitest";
import { ipBucket } from "../src/http/ip.js";

describe("ipBucket", () => {
  it("returns valid IPv4 addresses unchanged, and unwraps IPv4-mapped IPv6", () => {
    expect(ipBucket("203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucket(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(ipBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucket("::ffff:cb00:7107")).toBe("203.0.113.7");
  });

  it("buckets IPv6 by /64, whatever the notation", () => {
    const b = "2001:db8:1:2::/64";
    for (const a of ["2001:db8:1:2::1", "2001:0db8:0001:0002:ffff:ffff:ffff:ffff", "2001:DB8:1:2:0:0:0:5", "[2001:db8:1:2::9]", "2001:db8:1:2::1%eth0"]) expect(ipBucket(a), a).toBe(b);
    expect(ipBucket("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(ipBucket("::1")).toBe("0:0:0:0::/64");
    expect(ipBucket("::")).toBe("0:0:0:0::/64");
  });

  it("rejects everything that is not an IP literal (so it never reaches a limiter key or the audit log)", () => {
    for (const bad of [undefined, null, "", " ", "unknown", "1.2.3", "999.1.1.1", "1.2.3.4, 5.6.7.8", "evil<script>", "'; DROP TABLE users;--", "1.2.3.4:80", "2001:db8::g", "a".repeat(100), ":::", "1:2:3:4:5:6:7:8:9"]) {
      expect(ipBucket(bad as string | undefined), String(bad)).toBeNull();
    }
  });
});
