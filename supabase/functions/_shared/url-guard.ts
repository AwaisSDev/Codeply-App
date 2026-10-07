// Codeply: base URL checks for user-supplied model endpoints (SSRF guard).
//
// A synced model's base URL is typed by the user, and the edge function later
// calls it with a decrypted key. So only public https endpoints are allowed:
// no plain http, no credentials in the URL, no odd ports, and no hostname or
// resolved address that points at loopback, private, link-local (cloud
// metadata), carrier-grade NAT, multicast or reserved space.
//
// Plain functions (the DNS resolver is passed in), so it runs in Deno and
// Node alike. See supabase/tests/model-keys.test.mjs.

export type UrlCheck = { ok: true; url: string; host: string } | { ok: false; error: string };

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".corp", ".intranet", ".private"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data"]);

function v4Parts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n >= 0 && n <= 255) ? p : null;
}

/** True for every IPv4 address that is not ordinary public unicast. */
export function isPrivateV4(p: number[]): boolean {
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)        // carrier-grade NAT
    || (a === 169 && b === 254)                   // link-local, cloud metadata
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19))      // benchmarking
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

/** Expands an IPv6 literal (no brackets) to 8 groups, or null. */
function v6Groups(host: string): number[] | null {
  let h = host.toLowerCase();
  if (h.includes("%")) return null; // zone ids only make sense on local links
  // A trailing dotted IPv4 (::ffff:1.2.3.4) becomes two hex groups first.
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (v4) {
    const p = v4Parts(v4[1]);
    if (!p) return null;
    h = h.slice(0, -v4[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s ? s.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  if ([...left, ...right].some((n) => Number.isNaN(n))) return null;
  if (halves.length === 2) {
    const fill = 8 - left.length - right.length;
    if (fill < 1) return null;
    return [...left, ...new Array(fill).fill(0), ...right];
  }
  return left.length === 8 ? left : null;
}

export function isPrivateV6(g: number[]): boolean {
  const allZeroUntil = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (allZeroUntil(8)) return true;                                   // ::
  if (allZeroUntil(7) && g[7] === 1) return true;                     // ::1
  if (allZeroUntil(5) && g[5] === 0xffff) {                           // ::ffff:a.b.c.d
    return isPrivateV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
  }
  if (allZeroUntil(6)) return true;                                   // deprecated ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) {                             // NAT64
    return isPrivateV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true;                        // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true;                        // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true;                        // site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true;                        // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;                // documentation
  if (g[0] === 0x2002) {                                              // 6to4 carries an IPv4
    return isPrivateV4([g[1] >> 8, g[1] & 255, g[2] >> 8, g[2] & 255]);
  }
  return false;
}

/** True when an IP literal (v4 or v6) is not public. Non-IP input returns null. */
export function isPrivateIp(ip: string): boolean | null {
  const s = ip.replace(/^\[|\]$/g, "");
  const p4 = v4Parts(s);
  if (p4) return isPrivateV4(p4);
  if (s.includes(":")) {
    const g = v6Groups(s);
    return g ? isPrivateV6(g) : true; // unparseable v6: treat as unsafe
  }
  return null;
}

/** Synchronous checks on the URL itself. Normalizes it (no trailing slash). */
export function checkBaseUrl(raw: string): UrlCheck {
  const input = String(raw || "").trim();
  if (!input || input.length > 500) return { ok: false, error: "Enter the model's base URL." };
  let u: URL;
  try { u = new URL(input); } catch { return { ok: false, error: "That base URL is not a valid address." }; }
  if (u.protocol !== "https:") return { ok: false, error: "Only https addresses can be used from your phone." };
  if (u.username || u.password) return { ok: false, error: "Remove the user name or password from the base URL." };
  if (u.port && u.port !== "443") return { ok: false, error: "Only the standard https port (443) can be used from your phone." };
  if (u.hash) return { ok: false, error: "Remove the # part from the base URL." };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, error: "That base URL has no host." };
  const ip = isPrivateIp(host);
  if (ip === true) return { ok: false, error: "That address is on a private network, so the phone cannot use it." };
  if (ip === null) {
    if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
      return { ok: false, error: "That address is on a private network, so the phone cannot use it." };
    }
    if (!host.includes(".")) return { ok: false, error: "Use the provider's full public address (for example api.openai.com)." };
    if (!/^[a-z0-9.-]+$/.test(host)) return { ok: false, error: "That base URL has an invalid host name." };
  }
  const url = `${u.origin}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  return { ok: true, url, host };
}

export type Resolver = (host: string, type: "A" | "AAAA") => Promise<string[]>;

/**
 * Resolves the host and rejects it if ANY address is private, so a public
 * name pointing at an internal address is caught too. A resolver that is
 * not available in this runtime is skipped (the literal checks still hold);
 * a name that does not resolve at all is rejected.
 */
export async function checkResolvedHost(host: string, resolve: Resolver | null): Promise<UrlCheck | null> {
  if (isPrivateIp(host) !== null || !resolve) return null;
  const addrs: string[] = [];
  let unsupported = false;
  for (const type of ["A", "AAAA"] as const) {
    try { addrs.push(...(await resolve(host, type))); }
    catch (e) {
      const name = (e as Error)?.name || "";
      if (name === "NotSupported" || name === "PermissionDenied" || name === "TypeError") unsupported = true;
    }
  }
  if (!addrs.length) return unsupported ? null : { ok: false, error: "That base URL's host could not be found." };
  if (addrs.some((a) => isPrivateIp(a) !== false)) {
    return { ok: false, error: "That address points to a private network, so the phone cannot use it." };
  }
  return null;
}
