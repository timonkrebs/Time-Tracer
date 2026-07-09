/**
 * Normalises a self-hosted / custom instance base URL to its origin — e.g.
 * `git.example.com/path` → `https://git.example.com` — assuming `https` when no
 * scheme is given, so a trailing slash or path can't fork the value.
 *
 * Returns `null` for anything that is not a plain, publicly-routable web
 * address: an unparseable value, a non-`http(s)` scheme (`javascript:`,
 * `data:`, `file:`, `ftp:`…), or a host that points at the visitor's own
 * machine or network — `localhost` and IP literals in loopback, private
 * (RFC 1918), carrier-grade-NAT, link-local (incl. the `169.254.169.254`
 * cloud-metadata address) or unspecified ranges, IPv4 and IPv6 alike.
 *
 * The instance host is user-controlled — it is typed into the start-page form
 * and travels in a shareable `host` query param — and it is used to build API
 * request URLs and outbound links. Rejecting these here, at the one place the
 * host is trusted, keeps a crafted link from turning a `fetch()` into a probe
 * of the visitor's intranet or metadata service (the browser-side shape of
 * SSRF). Wildcard-DNS / rebinding names that *encode* the address in the host
 * (`127.0.0.1.nip.io`, `127-0-0-1.sslip.io`) are caught too; a name that merely
 * *resolves* to such an address through a private DNS record (a corporate
 * `git.internal`) can't be — not without resolving it, which is the browser's
 * job, not ours — and stays reachable.
 */
export function normalizeInstanceHost(host: string): string | null {
  const trimmed = host.trim();
  if (!trimmed) return null;

  // Decide whether the input already carries a URL scheme. A bare `host:port`
  // (`git.example.com:8443`) looks like `scheme:rest` up to the colon, so a
  // leading token + `:` only counts as a scheme when it is followed by `//`
  // (`scheme://…`) or is an opaque `scheme:rest` that plainly is not host:port —
  // the token has no dot and the colon is not followed by a port number. That
  // routes the dangerous opaque forms (`javascript:alert`, `data:…`, `file:/etc`,
  // `ssh:git@…`, `mailto:…`) through URL parsing so their non-http(s) protocol is
  // rejected below, while host:port and scheme-less hosts get the https default.
  const scheme = /^([a-z][a-z0-9+.-]*):(\/\/)?/i.exec(trimmed);
  const hasScheme =
    !!scheme &&
    (scheme[2] === '//' ||
      (!scheme[1].includes('.') && !/^\d/.test(trimmed.slice(scheme[0].length))));

  let url: URL;
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (isBlockedHostname(url.hostname)) return null;
  return url.origin;
}

/**
 * Whether a URL hostname points at a non-public address. The hostname is taken
 * as the URL parser normalises it — IPv4 shorthands (`127.1`, `0x7f.1`,
 * decimal) are already expanded to dotted quads and IPv6 literals arrive
 * bracketed — so this only has to classify the canonical form.
 */
export function isBlockedHostname(hostname: string): boolean {
  const name = hostname.toLowerCase();

  // `localhost` and anything under the reserved `.localhost` TLD (RFC 6761).
  if (name === 'localhost' || name.endsWith('.localhost')) return true;

  // IPv6 literals arrive bracketed, e.g. `[::1]`.
  if (name.startsWith('[') && name.endsWith(']')) {
    return isBlockedIpv6(name.slice(1, -1));
  }

  if (isIpv4(name)) return isBlockedIpv4(name);

  // Wildcard-DNS / rebinding services (nip.io, sslip.io, …) encode the target in
  // the *name*, so a public host like `127.0.0.1.nip.io`, `app.10.0.0.1.example`
  // or the dash form `127-0-0-1.nip.io` resolves straight to that address while
  // sailing past the literal-IP checks above. Classify any IPv4 the labels embed.
  if (embedsBlockedIpv4(name)) return true;

  // A bare hostname we can't resolve here — leave it to the browser. A name with
  // a *public* DNS record pointing into private space (no IP in the name) can't
  // be caught without resolving it, which the browser does, not us.
  return false;
}

/**
 * Whether a hostname's labels embed a non-public IPv4 the way wildcard-DNS /
 * rebinding services encode it: four consecutive numeric labels anywhere
 * (`127.0.0.1.nip.io`, `app.10.0.0.1.example`) or a dash-joined label
 * (`127-0-0-1.nip.io`). Such a name resolves directly to that IP, so a private,
 * loopback or metadata target is rejected even though the name itself is public.
 */
function embedsBlockedIpv4(name: string): boolean {
  const labels = name.split('.');
  // A dash-encoded label, e.g. `127-0-0-1` → `127.0.0.1`.
  for (const label of labels) {
    const dashed = /^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})$/.exec(label);
    if (dashed && isBlockedIpv4(dashed.slice(1).join('.'))) return true;
  }
  // Four consecutive numeric labels anywhere, e.g. `…127.0.0.1…`.
  for (let i = 0; i + 4 <= labels.length; i++) {
    const quad = labels.slice(i, i + 4);
    if (quad.every((l) => /^\d{1,3}$/.test(l)) && isBlockedIpv4(quad.join('.'))) return true;
  }
  return false;
}

function isIpv4(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function isBlockedIpv4(host: string): boolean {
  const [a, b] = host.split('.').map(Number);
  if (a > 255 || b > 255) return false; // not a real IPv4 — treat as a name
  return (
    a === 0 || // 0.0.0.0/8 "this host"
    a === 127 || // 127.0.0.0/8 loopback
    a === 10 || // 10.0.0.0/8 private
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local incl. metadata
    (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 carrier-grade NAT
  );
}

function isBlockedIpv6(host: string): boolean {
  const groups = expandIpv6(host);
  if (!groups) return false;

  if (groups.every((g) => g === 0)) return true; // :: unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1 loopback

  // IPv4-mapped (::ffff:a.b.c.d): classify the embedded IPv4 address.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const a = groups[6] >> 8;
    const b = groups[6] & 0xff;
    const c = groups[7] >> 8;
    const d = groups[7] & 0xff;
    return isBlockedIpv4(`${a}.${b}.${c}.${d}`);
  }

  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/** Expands an IPv6 literal (with optional `::` and embedded IPv4) to 8 hextets. */
function expandIpv6(host: string): number[] | null {
  let text = host;

  // Fold a trailing embedded IPv4 (`::ffff:127.0.0.1`) into two hextets.
  const v4 = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const octets = v4[1].split('.').map(Number);
    if (octets.some((n) => n > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, v4.index)}${hi}:${lo}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;

  let parts: string[];
  if (tail === null) {
    parts = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    parts = [...head, ...Array<string>(fill).fill('0'), ...tail];
  }
  if (parts.length !== 8) return null;

  const nums = parts.map((p) => parseInt(p || '0', 16));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}
