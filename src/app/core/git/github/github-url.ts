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
 * Note: for `tree`/`blob` URLs the ref is taken as the first segment after the
 * keyword; branch names containing `/` cannot be disambiguated without an API
 * round trip — callers re-split afterwards via `GitProvider.resolveRefPath`.
 */
export function parseGithubUrl(input: string): ParsedRepoUrl | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (ssh) return validated(ssh[1], ssh[2]);

  const url = tryParseHttpUrl(trimmed);
  if (url) {
    const host = url.hostname.toLowerCase();
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (host === 'github.com' || host === 'www.github.com') {
      return fromGithubSegments(segments);
    }
    if (host === 'raw.githubusercontent.com') {
      if (segments.length < 3) return null;
      const [owner, repo, ref, ...path] = segments;
      return validated(owner, repo, ref, path.join('/') || undefined);
    }
    return null;
  }

  // Bare `owner/repo` shorthand (no scheme, no host).
  const shorthand = trimmed.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (shorthand && !trimmed.includes(':')) {
    return validated(shorthand[1], shorthand[2]);
  }

  return null;
}

function fromGithubSegments(segments: string[]): ParsedRepoUrl | null {
  if (segments.length < 2) return null;
  const [owner, rawRepo, keyword, ref, ...rest] = segments;
  const repo = rawRepo.replace(/\.git$/i, '');

  if (segments.length === 2) return validated(owner, repo);

  if ((keyword === 'tree' || keyword === 'blob' || keyword === 'raw') && ref) {
    return validated(owner, repo, ref, rest.join('/') || undefined);
  }

  if (keyword === 'commit' && ref) {
    return validated(owner, repo, ref);
  }

  // Other GitHub sub-pages (issues, pulls, …) still identify the repo.
  return validated(owner, repo);
}

function tryParseHttpUrl(input: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    ? input
    : /^(www\.)?(github\.com|raw\.githubusercontent\.com)\//i.test(input)
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

function validated(owner: string, repo: string, ref?: string, path?: string): ParsedRepoUrl | null {
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) return null;
  return { owner, repo, ...(ref ? { ref } : {}), ...(path ? { path } : {}) };
}
