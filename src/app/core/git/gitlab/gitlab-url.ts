import { ParsedRepoUrl } from '../../models';
import { normalizeInstanceHost } from '../host-url';

const SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;

/**
 * Parses GitLab repository references:
 *
 * - `https://gitlab.com/owner/repo` (optional `.git`, trailing `/`)
 * - nested groups: `https://gitlab.com/group/subgroup/repo`
 * - `https://gitlab.com/owner/repo/-/tree/<ref>[/<path>]`
 * - `https://gitlab.com/owner/repo/-/blob/<ref>/<path>`
 * - `git@gitlab.com:owner/repo.git`
 *
 * Pass `host` (e.g. `https://gitlab.example.com`) to parse a self-hosted
 * GitLab reference instead — the same shapes are recognised against that host,
 * a bare `group/…/repo` is treated as a project path on it, and the result
 * carries the host so the provider targets that instance.
 *
 * For nested groups everything before the project name becomes `owner`
 * (slashes included) — GitLab's API addresses projects by the full
 * namespace path.
 */
export function parseGitlabUrl(input: string, host?: string): ParsedRepoUrl | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // A self-hosted host must be a plain http(s) origin; reject dangerous or
  // malformed schemes (javascript:, data:, file:…) rather than carrying them on.
  let origin: string | undefined;
  if (host) {
    const normalized = normalizeInstanceHost(host);
    if (!normalized) return null;
    origin = normalized;
  }
  const hostname = origin ? new URL(origin).hostname.toLowerCase() : null;

  const ssh = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?\/?$/i);
  if (ssh) {
    const sshHost = ssh[1].toLowerCase();
    if (hostname ? sshHost === hostname : sshHost === 'gitlab.com') {
      return fromProjectPath(ssh[2].split('/'), undefined, undefined, origin);
    }
    return null;
  }

  const url = tryParseHttpUrl(trimmed, hostname);
  if (url) {
    const h = url.hostname.toLowerCase();
    if (hostname ? h !== hostname : h !== 'gitlab.com' && h !== 'www.gitlab.com') return null;
    return fromSegments(url.pathname.split('/').filter(Boolean).map(decodeSegment), origin);
  }

  // No scheme/host. With a declared custom host, treat the input as a project path.
  if (hostname) {
    return fromSegments(
      trimmed.replace(/^\/+/, '').split('/').filter(Boolean).map(decodeSegment),
      origin,
    );
  }

  return null;
}

function fromSegments(segments: string[], host?: string): ParsedRepoUrl | null {
  const dashIndex = segments.indexOf('-');
  if (dashIndex === -1) {
    return fromProjectPath(segments, undefined, undefined, host);
  }
  // `…/-/tree/<ref>[/<path>]` and `…/-/blob/<ref>/<path>` style URLs.
  const project = segments.slice(0, dashIndex);
  const [keyword, ref, ...rest] = segments.slice(dashIndex + 1);
  if ((keyword === 'tree' || keyword === 'blob' || keyword === 'raw') && ref) {
    return fromProjectPath(project, ref, rest.join('/') || undefined, host);
  }
  if (keyword === 'commit' && ref) {
    return fromProjectPath(project, ref, undefined, host);
  }
  return fromProjectPath(project, undefined, undefined, host);
}

function fromProjectPath(
  rawSegments: string[],
  ref?: string,
  path?: string,
  host?: string,
): ParsedRepoUrl | null {
  if (rawSegments.length < 2) return null;
  const segments = [...rawSegments];
  segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/i, '');
  if (!segments.every((segment) => SEGMENT_PATTERN.test(segment))) return null;
  const repo = segments[segments.length - 1];
  const owner = segments.slice(0, -1).join('/');
  return {
    owner,
    repo,
    ...(ref ? { ref } : {}),
    ...(path ? { path } : {}),
    ...(host ? { host } : {}),
  };
}

function tryParseHttpUrl(input: string, customHostname: string | null): URL | null {
  let withScheme: string | null = null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    withScheme = input;
  } else if (/^(www\.)?gitlab\.com\//i.test(input)) {
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

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
