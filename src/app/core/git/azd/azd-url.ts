import { ParsedRepoUrl } from '../../models';

/**
 * Parses Azure DevOps repository references:
 *
 * - `https://dev.azure.com/{org}/{project}/_git/{repo}` — including deeper
 *   pages like `/pullrequest/13619`, `/commit/<sha>`, `/branches`, …
 * - `?path=/src/x.ts&version=GBmain` query state (GB=branch, GC=commit,
 *   GT=tag) is mapped to ref/path
 * - legacy `https://{org}.visualstudio.com/{project}/_git/{repo}`
 * - SSH: `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}`
 *
 * `owner` becomes `{org}/{project}` (the API addresses repos beneath both).
 */
export function parseAzdUrl(input: string): ParsedRepoUrl | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const ssh = trimmed.match(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+?)\/?$/i);
  if (ssh) {
    return build(ssh[1], ssh[2], ssh[3]);
  }

  const url = tryParseHttpUrl(trimmed);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean).map(decodeSegment);

  let org: string | undefined;
  let rest: string[];
  if (host === 'dev.azure.com') {
    [org, ...rest] = segments;
  } else if (host.endsWith('.visualstudio.com')) {
    org = host.slice(0, -'.visualstudio.com'.length);
    rest = segments;
  } else {
    return null;
  }
  if (!org) return null;

  const gitIndex = rest.indexOf('_git');
  if (gitIndex < 1 || gitIndex + 1 >= rest.length) return null;
  const project = rest.slice(0, gitIndex).join('/');
  const repo = rest[gitIndex + 1];
  const tail = rest.slice(gitIndex + 2);

  let ref: string | undefined;
  if (tail[0] === 'commit' && tail[1]) ref = tail[1];

  const version = url.searchParams.get('version');
  if (version && /^G[BCT]/.test(version)) ref = version.slice(2);
  const rawPath = url.searchParams.get('path');
  const path = rawPath ? rawPath.replace(/^\//, '') : undefined;

  return build(org, project, repo, ref, path);
}

function build(
  org: string,
  project: string,
  repo: string,
  ref?: string,
  path?: string,
): ParsedRepoUrl | null {
  const cleanRepo = repo.replace(/\.git$/i, '');
  if (!org || !project || !cleanRepo) return null;
  if ([org, project, cleanRepo].some((s) => s.includes('?') || s.includes('#'))) return null;
  return {
    owner: `${org}/${project}`,
    repo: cleanRepo,
    ...(ref ? { ref } : {}),
    ...(path ? { path } : {}),
  };
}

function tryParseHttpUrl(input: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    ? input
    : /^(dev\.azure\.com|[a-z0-9-]+\.visualstudio\.com)\//i.test(input)
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

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
