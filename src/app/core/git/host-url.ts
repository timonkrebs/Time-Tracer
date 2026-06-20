/**
 * Normalises a self-hosted / custom instance base URL to its origin — e.g.
 * `git.example.com/path` → `https://git.example.com` — assuming `https` when no
 * scheme is given, so a trailing slash or path can't fork the value.
 *
 * Returns `null` for anything that is not a plain web address: an unparseable
 * value, or a non-`http(s)` scheme (`javascript:`, `data:`, `file:`, `ftp:`…).
 * The instance host is user-controlled — it is typed into the start-page form
 * and travels in a shareable `host` query param — and it is used to build API
 * request URLs and outbound links, so rejecting dangerous schemes here keeps
 * them out of every `fetch()` and `href` at the one place the host is trusted.
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
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
}

/** Lowercased hostname of an instance origin, or `null` if it isn't a web address. */
export function instanceHostname(host: string): string | null {
  const origin = normalizeInstanceHost(host);
  return origin ? new URL(origin).hostname.toLowerCase() : null;
}
