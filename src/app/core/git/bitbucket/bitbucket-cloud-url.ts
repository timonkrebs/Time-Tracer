import { ParsedRepoUrl } from '../../models';
import { decodeSegment, hasUrlScheme, parseHttpUrl } from '../url-util';

const SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;

/**
 * Parses Bitbucket Cloud (bitbucket.org) repository references:
 *
 * - `https://bitbucket.org/{workspace}/{repo}` (optional `.git`, trailing `/`)
 * - `https://bitbucket.org/{workspace}/{repo}/src/<ref>[/<path>]`
 * - `https://bitbucket.org/{workspace}/{repo}/commits/<sha>`
 * - `git@bitbucket.org:{workspace}/{repo}.git`
 *
 * `owner` is the workspace id; `repo` is the repository slug. Like the other
 * `src`/`tree` URLs, a ref containing `/` cannot be disambiguated from the URL
 * alone — the first segment after `src` is taken as the ref.
 */
export function parseBitbucketCloudUrl(input: string): ParsedRepoUrl | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const ssh = trimmed.match(/^git@bitbucket\.org:([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (ssh) return validated(ssh[1], ssh[2]);

  const url = tryParseHttpUrl(trimmed);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (host !== 'bitbucket.org' && host !== 'www.bitbucket.org') return null;

  const segments = url.pathname.split('/').filter(Boolean).map(decodeSegment);
  return fromSegments(segments);
}

function fromSegments(segments: string[]): ParsedRepoUrl | null {
  if (segments.length < 2) return null;
  const [workspace, rawRepo, keyword, ref, ...rest] = segments;
  const repo = rawRepo.replace(/\.git$/i, '');

  if (segments.length === 2) return validated(workspace, repo);

  if (keyword === 'src' && ref) {
    return validated(workspace, repo, ref, rest.join('/') || undefined);
  }
  if ((keyword === 'commits' || keyword === 'commit') && ref) {
    return validated(workspace, repo, ref);
  }
  // Other sub-pages (pull-requests, branches, …) still identify the repo.
  return validated(workspace, repo);
}

function tryParseHttpUrl(input: string): URL | null {
  const withScheme = hasUrlScheme(input)
    ? input
    : /^(www\.)?bitbucket\.org\//i.test(input)
      ? `https://${input}`
      : null;
  return withScheme ? parseHttpUrl(withScheme) : null;
}

function validated(
  workspace: string,
  repo: string,
  ref?: string,
  path?: string,
): ParsedRepoUrl | null {
  if (!SEGMENT_PATTERN.test(workspace) || !SEGMENT_PATTERN.test(repo)) return null;
  return { owner: workspace, repo, ...(ref ? { ref } : {}), ...(path ? { path } : {}) };
}
