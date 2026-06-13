import { ParsedRepoUrl } from '../../models';

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Parses the many shapes a "GitHub repo" can be written in:
 *
 * - `owner/repo` shorthand
 * - `https://github.com/owner/repo` (optional `www.`, trailing `/`, `.git`)
 * - `https://github.com/owner/repo/tree/<ref>[/<path>]`
 * - `https://github.com/owner/repo/blob/<ref>/<path>`
 * - `git@github.com:owner/repo.git`
 * - `https://raw.githubusercontent.com/owner/repo/<ref>/<path>`
 *
 * Pass `host` (e.g. `https://github.example.com`) to parse a GitHub Enterprise
 * Server reference instead: the same path shapes are recognised against that
 * host, a bare `owner/repo[/…]` is treated as a path on it, and the resulting
 * {@link ParsedRepoUrl} carries the host so the provider targets that instance.
 *
 * Note: for `tree`/`blob` URLs the ref is taken as the first segment after the
 * keyword; branch names containing `/` cannot be disambiguated without an API
 * round trip — callers re-split afterwards via `GitProvider.resolveRefPath`.
 */
export function parseGithubUrl(input: string, host?: string): ParsedRepoUrl | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const hostname = host ? hostnameOf(host) : null;
  const origin = host ? normalizeHost(host) : undefined;

  const ssh = trimmed.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (ssh) {
    const sshHost = ssh[1].toLowerCase();
    if (hostname ? sshHost === hostname : sshHost === 'github.com') {
      return validated(ssh[2], ssh[3], undefined, undefined, origin);
    }
    return null;
  }

  const url = tryParseHttpUrl(trimmed, hostname);
  if (url) {
    const h = url.hostname.toLowerCase();
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (hostname) {
      return h === hostname ? fromGithubSegments(segments, origin) : null;
    }
    if (h === 'github.com' || h === 'www.github.com') {
      return fromGithubSegments(segments);
    }
    if (h === 'raw.githubusercontent.com') {
      if (segments.length < 3) return null;
      const [owner, repo, ref, ...path] = segments;
      return validated(owner, repo, ref, path.join('/') || undefined);
    }
    return null;
  }

  // No scheme/host in the input. With a declared custom host, treat the whole
  // input as a repo path on it (`owner/repo`, `owner/repo/tree/<ref>/<path>`…).
  if (hostname) {
    const segments = trimmed.replace(/^\/+/, '').split('/').filter(Boolean).map(decodeSegment);
    return fromGithubSegments(segments, origin);
  }

  // Bare `owner/repo` shorthand (no scheme, no host).
  const shorthand = trimmed.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (shorthand && !trimmed.includes(':')) {
    return validated(shorthand[1], shorthand[2]);
  }

  return null;
}

function fromGithubSegments(segments: string[], host?: string): ParsedRepoUrl | null {
  if (segments.length < 2) return null;
  const [owner, rawRepo, keyword, ref, ...rest] = segments;
  const repo = rawRepo.replace(/\.git$/i, '');

  if (segments.length === 2) return validated(owner, repo, undefined, undefined, host);

  if ((keyword === 'tree' || keyword === 'blob' || keyword === 'raw') && ref) {
    return validated(owner, repo, ref, rest.join('/') || undefined, host);
  }

  if (keyword === 'commit' && ref) {
    return validated(owner, repo, ref, undefined, host);
  }

  // Other GitHub sub-pages (issues, pulls, …) still identify the repo.
  return validated(owner, repo, undefined, undefined, host);
}

function tryParseHttpUrl(input: string, customHostname: string | null): URL | null {
  let withScheme: string | null = null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    withScheme = input;
  } else if (/^(www\.)?(github\.com|raw\.githubusercontent\.com)\//i.test(input)) {
    withScheme = `https://${input}`;
  } else if (customHostname && input.toLowerCase().startsWith(`${customHostname}/`)) {
    withScheme = `https://${input}`;
  }
  if (!withScheme) return null;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function validated(
  owner: string,
  repo: string,
  ref?: string,
  path?: string,
  host?: string,
): ParsedRepoUrl | null {
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) return null;
  return {
    owner,
    repo,
    ...(ref ? { ref } : {}),
    ...(path ? { path } : {}),
    ...(host ? { host } : {}),
  };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Hostname of a base origin, tolerant of a missing scheme. */
function hostnameOf(host: string): string {
  try {
    return new URL(maybeScheme(host)).hostname.toLowerCase();
  } catch {
    return host
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .replace(/\/.*$/, '');
  }
}

/** Origin of a base host, tolerant of a missing scheme. */
function normalizeHost(host: string): string {
  try {
    return new URL(maybeScheme(host)).origin;
  } catch {
    return host.replace(/\/+$/, '');
  }
}

function maybeScheme(host: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `https://${host}`;
}
