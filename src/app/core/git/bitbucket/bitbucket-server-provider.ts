import { Injectable, inject } from '@angular/core';

import {
  CommitFileChange,
  CommitInfo,
  ParsedRepoUrl,
  RepoBranchList,
  RepoFile,
  RepoMetadata,
  RepoProviderError,
  RepoSlug,
  RepoTree,
  TreeEntry,
} from '../../models';
import { bytesToUtf8, isProbablyBinary } from '../../util/decode';
import { AccessTokens } from '../access-tokens';
import { GitProvider, RepoWebLinks } from '../git-provider';
import { bitbucketAuthHeader } from './bitbucket-auth';
import { parseBitbucketServerUrl } from './bitbucket-server-url';

/** Files above this size are not fetched; the UI links to the instance instead. */
const MAX_FILE_SIZE_BYTES = 2_000_000;

/** Listings page at 1000/100 entries; stop after this many pages and mark truncated. */
const MAX_PAGES = 50;

/** Branch pages are 100 entries; stop after this many pages and mark truncated. */
const MAX_BRANCH_PAGES = 10;

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

interface BbsPaged<T> {
  values?: T[];
  isLastPage?: boolean;
  nextPageStart?: number;
}

interface BbsRepo {
  slug: string;
  name: string;
  project: { key: string; name: string };
  links?: { self?: { href?: string }[] };
  origin?: unknown;
}

interface BbsCommit {
  id: string;
  displayId: string;
  message?: string;
  author?: { name?: string; emailAddress?: string };
  authorTimestamp?: number;
  parents?: { id: string }[];
}

interface BbsChange {
  type: string;
  path: Record<string, string>;
  srcPath?: Record<string, string>;
}

/**
 * Reads repositories through the Bitbucket Server / Data Center REST API
 * (1.0). The instance base comes from the slug's `host`. A stored token (an
 * HTTP access token, sent as Bearer, or a `user:password` pair sent as Basic)
 * authenticates private projects and raises limits. `owner` carries the
 * project key (`~user` for personal projects).
 *
 * Like Bitbucket Cloud, content is addressed by `<commit>/<path>`, so tree
 * entries carry the resolved tree commit as their `sha` (used only to fetch
 * content).
 */
@Injectable({ providedIn: 'root' })
export class BitbucketServerProvider implements GitProvider {
  readonly id = 'bitbucket-server';
  readonly label = 'Bitbucket Server';

  private readonly tokens = inject(AccessTokens);

  canHandle(): boolean {
    // Self-hosted only: reached through the start page's custom-host form,
    // never auto-detected from a bare URL.
    return false;
  }

  parseUrl(): ParsedRepoUrl | null {
    return null;
  }

  parseHostedUrl(input: string, host: string): ParsedRepoUrl | null {
    return parseBitbucketServerUrl(input, host);
  }

  async getMetadata(slug: RepoSlug): Promise<RepoMetadata> {
    const data = await this.getJson<BbsRepo>(slug, repoApi(slug), {
      notFound: 'Repository not found — it may not exist or it may be private.',
    });
    let defaultBranch = 'main';
    try {
      const branch = await this.getJson<{ displayId?: string }>(
        slug,
        `${repoApi(slug)}/branches/default`,
        { notFound: 'No default branch.' },
      );
      if (branch.displayId) defaultBranch = branch.displayId;
    } catch {
      // Older instances or empty repos may lack a default branch — fall back.
    }
    return {
      owner: slug.owner,
      name: data.slug,
      fullName: `${data.project.key}/${data.slug}`,
      description: null,
      defaultBranch,
      htmlUrl:
        data.links?.self?.[0]?.href ?? `${webBase(slug)}/projects/${slug.owner}/repos/${slug.repo}`,
      starCount: 0,
      isFork: data.origin !== undefined,
    };
  }

  async listBranches(slug: RepoSlug): Promise<RepoBranchList> {
    const names: string[] = [];
    let start = 0;
    for (let page = 1; ; page++) {
      const data = await this.getJson<BbsPaged<{ displayId: string }>>(
        slug,
        `${repoApi(slug)}/branches?orderBy=ALPHABETICAL&limit=100&start=${start}`,
        { notFound: 'Repository not found — it may not exist or it may be private.' },
      );
      for (const branch of data.values ?? []) names.push(branch.displayId);
      if (data.isLastPage !== false || data.nextPageStart == null) {
        return { names, truncated: false };
      }
      if (page >= MAX_BRANCH_PAGES) return { names, truncated: true };
      start = data.nextPageStart;
    }
  }

  async getTree(slug: RepoSlug, ref: string): Promise<RepoTree> {
    const resolvedCommit = SHA_PATTERN.test(ref) ? ref : await this.firstCommitId(slug, ref);
    const entries: TreeEntry[] = [];
    let start = 0;
    let truncated = false;
    for (let page = 1; ; page++) {
      const data = await this.getJson<BbsPaged<string>>(
        slug,
        `${repoApi(slug)}/files?at=${encodeURIComponent(ref)}&limit=1000&start=${start}`,
        { notFound: `Ref "${ref}" was not found in this repository.`, notFoundKind: 'invalid-ref' },
      );
      for (const path of data.values ?? []) {
        entries.push({
          path,
          name: path.slice(path.lastIndexOf('/') + 1),
          kind: 'file',
          sha: resolvedCommit || ref,
        });
      }
      if (data.isLastPage !== false || data.nextPageStart == null) break;
      if (page >= MAX_PAGES) {
        truncated = true;
        break;
      }
      start = data.nextPageStart;
    }
    if (entries.length === 0) {
      throw new RepoProviderError('This repository is empty.', 'empty-repo');
    }
    return { entries, truncated };
  }

  async getFile(slug: RepoSlug, entry: TreeEntry): Promise<RepoFile> {
    return this.fetchRaw(slug, entry.path, entry.sha);
  }

  async getFileAtRef(slug: RepoSlug, path: string, ref: string): Promise<RepoFile> {
    return this.fetchRaw(slug, path, ref);
  }

  private async fetchRaw(slug: RepoSlug, path: string, commit: string): Promise<RepoFile> {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    // Raw bytes come from the web `/raw/` endpoint, not the `/rest/api/1.0` base.
    const response = await this.fetchChecked(
      slug,
      `${webBase(slug)}/projects/${encodeURIComponent(slug.owner)}/repos/${encodeURIComponent(slug.repo)}/raw/${encodedPath}?at=${encodeURIComponent(commit)}`,
      {
        notFound: `"${path}" does not exist at ${commit.slice(0, 7)} — it may have been added later or deleted by this commit.`,
      },
    );
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_FILE_SIZE_BYTES) {
      return { kind: 'too-large', path, sha: commit, size: declared };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_FILE_SIZE_BYTES) {
      return { kind: 'too-large', path, sha: commit, size: bytes.length };
    }
    if (isProbablyBinary(bytes)) {
      return { kind: 'binary', path, sha: commit, size: bytes.length };
    }
    return { kind: 'text', path, sha: commit, size: bytes.length, text: bytesToUtf8(bytes) };
  }

  async listCommits(
    slug: RepoSlug,
    options: { ref?: string; path?: string; perPage?: number; page?: number } = {},
  ): Promise<CommitInfo[]> {
    const perPage = options.perPage ?? 30;
    // The instance may cap `limit` below the request (a configurable hard
    // limit) and report the real paging state via isLastPage/nextPageStart.
    // Accumulate until the requested window is full or history truly ends —
    // otherwise a capped instance would both skip commits (the next page's
    // `start` assumes the full window was served) and end walks early (a
    // short page reads as end-of-history to callers).
    const commits: CommitInfo[] = [];
    let start = ((options.page ?? 1) - 1) * perPage;
    for (;;) {
      const params = new URLSearchParams({ limit: String(perPage - commits.length) });
      params.set('start', String(start));
      if (options.ref) params.set('until', options.ref);
      if (options.path) params.set('path', options.path);

      const data = await this.getJson<BbsPaged<BbsCommit>>(
        slug,
        `${repoApi(slug)}/commits?${params}`,
        { notFound: 'No commit history found for this ref or path.' },
      );
      const values = data.values ?? [];
      for (const value of values) commits.push(mapCommit(value, slug));
      if (commits.length >= perPage || data.isLastPage !== false || values.length === 0) break;
      start = data.nextPageStart ?? start + values.length;
    }
    return commits;
  }

  async getCommit(slug: RepoSlug, sha: string): Promise<CommitInfo> {
    const data = await this.getJson<BbsCommit>(slug, `${repoApi(slug)}/commits/${encodeURIComponent(sha)}`, {
      notFound: `Commit ${sha.slice(0, 7)} was not found in this repository.`,
    });
    return mapCommit(data, slug);
  }

  async getCommitFiles(slug: RepoSlug, sha: string): Promise<CommitFileChange[]> {
    const files: CommitFileChange[] = [];
    let start = 0;
    for (let page = 1; ; page++) {
      const data = await this.getJson<BbsPaged<BbsChange>>(
        slug,
        `${repoApi(slug)}/commits/${encodeURIComponent(sha)}/changes?limit=1000&start=${start}`,
        { notFound: `Commit ${sha.slice(0, 7)} was not found in this repository.` },
      );
      for (const change of data.values ?? []) {
        const path = change.path?.['toString'];
        if (!path) continue;
        const type = change.type.toUpperCase();
        const status =
          type === 'ADD'
            ? 'added'
            : type === 'DELETE'
              ? 'removed'
              : type === 'RENAME' || type === 'MOVE'
                ? 'renamed'
                : 'modified';
        const previousPath = change.srcPath?.['toString'];
        files.push({
          path,
          status,
          ...(status === 'renamed' && previousPath && previousPath !== path ? { previousPath } : {}),
        });
      }
      if (data.isLastPage !== false || data.nextPageStart == null || page >= MAX_PAGES) break;
      start = data.nextPageStart;
    }
    return files;
  }

  webLinks(slug: RepoSlug, ref: string, path?: string): RepoWebLinks {
    const repoUrl = `${webBase(slug)}/projects/${encodeURIComponent(slug.owner)}/repos/${encodeURIComponent(slug.repo)}`;
    if (!path) return { repoUrl };
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const at = `?at=${encodeURIComponent(ref)}`;
    return {
      repoUrl,
      fileUrl: `${repoUrl}/browse/${encodedPath}${at}`,
      rawFileUrl: `${repoUrl}/raw/${encodedPath}${at}`,
    };
  }

  /** Latest commit id reachable from `ref`, or '' when there are none. */
  private async firstCommitId(slug: RepoSlug, ref: string): Promise<string> {
    const data = await this.getJson<BbsPaged<BbsCommit>>(
      slug,
      `${repoApi(slug)}/commits?until=${encodeURIComponent(ref)}&limit=1`,
      { notFound: `Ref "${ref}" was not found in this repository.`, notFoundKind: 'invalid-ref' },
    );
    return data.values?.[0]?.id ?? '';
  }

  private async getJson<T>(
    slug: RepoSlug,
    url: string,
    messages: { notFound: string; notFoundKind?: 'not-found' | 'invalid-ref' },
  ): Promise<T> {
    const response = await this.fetchChecked(slug, url, messages);
    return (await response.json()) as T;
  }

  private async fetchChecked(
    slug: RepoSlug,
    url: string,
    messages: { notFound: string; notFoundKind?: 'not-found' | 'invalid-ref' },
  ): Promise<Response> {
    const auth = bitbucketAuthHeader(this.tokens.tokenForSlug(slug));
    const init: RequestInit = auth ? { headers: { Authorization: auth } } : {};

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch {
      throw new RepoProviderError(
        'Could not reach the Bitbucket server — check the base URL and your connection.',
        'network',
      );
    }

    if (response.ok) return response;
    if (response.status === 401 || response.status === 403) {
      throw new RepoProviderError(
        auth
          ? 'The Bitbucket server rejected the access token — check that it is valid and has Repository Read.'
          : 'The Bitbucket server denied anonymous access — add an access token on the start page.',
        'not-found',
      );
    }
    if (response.status === 404) {
      throw new RepoProviderError(messages.notFound, messages.notFoundKind ?? 'not-found');
    }
    if (response.status === 429) {
      throw new RepoProviderError(
        'The Bitbucket server is rate-limiting requests — wait a bit and try again.',
        'rate-limited',
      );
    }
    throw new RepoProviderError(
      `Bitbucket server request failed with status ${response.status}.`,
      'unknown',
    );
  }
}

/** `<host>/rest/api/1.0/projects/{key}/repos/{slug}` */
function repoApi(slug: RepoSlug): string {
  return `${apiBase(slug)}/projects/${encodeURIComponent(slug.owner)}/repos/${encodeURIComponent(slug.repo)}`;
}

function apiBase(slug: RepoSlug): string {
  return `${webBase(slug)}/rest/api/1.0`;
}

function webBase(slug: RepoSlug): string {
  return (slug.host ?? '').replace(/\/+$/, '');
}

function mapCommit(item: BbsCommit, slug: RepoSlug): CommitInfo {
  const message = item.message ?? '';
  return {
    sha: item.id,
    message,
    summary: message.split('\n', 1)[0],
    authorName: item.author?.name ?? 'Unknown',
    authorEmail: item.author?.emailAddress ?? null,
    authoredAt: item.authorTimestamp ? new Date(item.authorTimestamp).toISOString() : '',
    htmlUrl: `${webBase(slug)}/projects/${slug.owner}/repos/${slug.repo}/commits/${item.id}`,
    parentShas: (item.parents ?? []).map((p) => p.id),
  };
}
