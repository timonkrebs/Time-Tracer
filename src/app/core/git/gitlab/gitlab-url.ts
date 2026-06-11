import { ParsedRepoUrl } from '../../models';

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
 * For nested groups everything before the project name becomes `owner`
 * (slashes included) — GitLab's API addresses projects by the full
 * namespace path.
 */
export function parseGitlabUrl(input: string): ParsedRepoUrl | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const ssh = trimmed.match(/^git@gitlab\.com:(.+?)(?:\.git)?\/?$/i);
  if (ssh) return fromProjectPath(ssh[1].split('/'));

  const url = tryParseHttpUrl(trimmed);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (host !== 'gitlab.com' && host !== 'www.gitlab.com') return null;

  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const dashIndex = segments.indexOf('-');
  if (dashIndex === -1) {
    return fromProjectPath(segments);
  }

  // `…/-/tree/<ref>[/<path>]` and `…/-/blob/<ref>/<path>` style URLs.
  const project = segments.slice(0, dashIndex);
  const [keyword, ref, ...rest] = segments.slice(dashIndex + 1);
  if ((keyword === 'tree' || keyword === 'blob' || keyword === 'raw') && ref) {
    return fromProjectPath(project, ref, rest.join('/') || undefined);
  }
  if (keyword === 'commit' && ref) {
    return fromProjectPath(project, ref);
  }
  return fromProjectPath(project);
}

function fromProjectPath(rawSegments: string[], ref?: string, path?: string): ParsedRepoUrl | null {
  if (rawSegments.length < 2) return null;
  const segments = [...rawSegments];
  segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/i, '');
  if (!segments.every((segment) => SEGMENT_PATTERN.test(segment))) return null;
  const repo = segments[segments.length - 1];
  const owner = segments.slice(0, -1).join('/');
  return { owner, repo, ...(ref ? { ref } : {}), ...(path ? { path } : {}) };
}

function tryParseHttpUrl(input: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    ? input
    : /^(www\.)?gitlab\.com\//i.test(input)
      ? `https://${input}`
      : null;
  if (!withScheme) return null;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
