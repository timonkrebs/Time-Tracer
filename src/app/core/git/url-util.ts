/**
 * URL-parsing primitives shared by the provider URL readers and their REST/web
 * base builders. Each provider's parser legitimately differs in *which* hosts it
 * recognises (github.com, gitlab.com, a self-hosted instance, …); these helpers
 * cover the parts that were otherwise repeated verbatim across them.
 */

/** True when `input` already begins with a `scheme://` authority. */
export function hasUrlScheme(input: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
}

/**
 * Parses `input` as an absolute URL and returns it only when it is http(s);
 * null for any other scheme or an unparseable value.
 */
export function parseHttpUrl(input: string): URL | null {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * `decodeURIComponent`, but returns the raw segment unchanged when it carries a
 * malformed percent-escape instead of throwing.
 */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Removes any trailing slashes — how each provider derives its API/web base. */
export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
