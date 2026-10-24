import { isIP } from "node:net";

/** Expands a valid IPv6 literal (no zone id) into its eight 16-bit groups, or null. */
function ipv6Groups(addr: string): number[] | null {
  let s = addr;
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const o = v4[1]!.split(".").map(Number);
    if (o.some((x) => x > 255)) return null;
    s = `${s.slice(0, v4.index)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

/**
 * Validates an address and returns its rate-limit / audit bucket, or null when it is not an IP literal.
 * IPv4 (including IPv4-mapped IPv6) is the address itself; IPv6 is bucketed by /64 (a single host can use billions
 * of addresses inside its /64, so per-address limiting would be meaningless): `xxxx:xxxx:xxxx:xxxx::/64`.
 */
export function ipBucket(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const a = raw.trim().replace(/%.*$/, "").replace(/^\[(.*)\]$/, "$1");
  if (a.length === 0 || a.length > 64) return null;
  const kind = isIP(a);
  if (kind === 4) return a;
  if (kind !== 6) return null;
  const g = ipv6Groups(a.toLowerCase());
  if (!g) return null;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`; // ::ffff:a.b.c.d
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}
