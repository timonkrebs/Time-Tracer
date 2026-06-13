import { ParsedRepoUrl } from '../../models';

const KEY_PATTERN = /^~?[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;

/**
 * Parses Bitbucket Server / Data Center repository references against a known
 * instance `host` (e.g. `https://bitbucket.example.com`):
 *
 * - `…/projects/{KEY}/repos/{repo}/browse/<path>?at=refs/heads/<branch>`
 * - `…/projects/{KEY}/repos/{repo}/commits/<sha>`
 * - `…/users/{user}/repos/{repo}/…` (personal projects, key `~user`)
 * - `…/scm/{key}/{repo}.git` (clone URL)
 * - SSH `ssh://git@host:7999/{KEY}/{repo}.git` or `git@host:{KEY}/{repo}.git`
 * - a bare `{KEY}/{repo}` path
 *
 * `owner` becomes the project key (`~user` for personal projects); the result
 * carries the host so the provider targets that instance.
 */
export function parseBitbucketServerUrl(input: string, host: string): ParsedRepoUrl | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const hostname = hostnameOf(host);
  const origin = normalizeHost(host);

  const ssh = trimmed.match(/^(?:ssh:\/\/)?git@([^:/]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i);
  if (ssh && ssh[1].toLowerCase() === hostname) {
    const segs = ssh[2].split('/').filter(Boolean);
    if (segs.length >= 2) return validated(segs[segs.length - 2], segs[segs.length - 1], undefined, undefined, origin);
    return null;
  }

  const url = tryParseHttpUrl(trimmed, hostname);
  if (url) {
    if (url.hostname.toLowerCase() !== hostname) return null;
    const segments = url.pathname.split('/').filter(Boolean).map(decodeSegment);
    return fromSegments(segments, url.searchParams.get('at'), origin);
  }

  // Scheme-less input: treat as a path on the instance.
  const segments = trimmed.replace(/^\/+/, '').split('/').filter(Boolean).map(decodeSegment);
  return fromSegments(segments, null, origin);
}

function fromSegments(segments: string[], at: string | null, host: string): ParsedRepoUrl | null {
  let key: string | undefined;
  let repo: string | undefined;
  let tail: string[] = [];

  if (segments[0] === 'scm' && segments.length >= 3) {
    key = segments[1];
    repo = segments[2];
  } else if (segments[0] === 'projects' && segments[2] === 'repos' && segments.length >= 4) {
    key = segments[1];
    repo = segments[3];
    tail = segments.slice(4);
  } else if (segments[0] === 'users' && segments[2] === 'repos' && segments.length >= 4) {
    key = `~${segments[1]}`;
    repo = segments[3];
    tail = segments.slice(4);
  } else if (segments.length >= 2) {
    key = segments[0];
    repo = segments[1];
    tail = segments.slice(2);
  }
  if (!key || !repo) return null;

  let ref: string | undefined;
  let path: string | undefined;
  if (tail[0] === 'browse') {
    path = tail.slice(1).join('/') || undefined;
  } else if (tail[0] === 'commits' && tail[1]) {
    ref = tail[1];
  }
  if (at) ref = stripRefPrefix(at);

  return validated(key, repo, ref, path, host);
}

function stripRefPrefix(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, '');
}

function tryParseHttpUrl(input: string, hostname: string): URL | null {
  let withScheme: string | null = null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    withScheme = input;
  } else if (input.toLowerCase().startsWith(`${hostname}/`)) {
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
  key: string,
  rawRepo: string,
  ref: string | undefined,
  path: string | undefined,
  host: string,
): ParsedRepoUrl | null {
  const repo = rawRepo.replace(/\.git$/i, '');
  if (!KEY_PATTERN.test(key) || !REPO_PATTERN.test(repo)) return null;
  return { owner: key, repo, ...(ref ? { ref } : {}), ...(path ? { path } : {}), host };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

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
