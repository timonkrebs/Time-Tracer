import { Injectable, inject } from '@angular/core';

import {
  CommitFileChange,
  CommitInfo,
  ParsedRepoUrl,
  RefResolution,
  RepoBranchList,
  RepoFile,
  RepoMetadata,
  RepoProviderError,
  RepoSlug,
  RepoTag,
  RepoTagList,
  RepoTree,
  TreeEntry,
} from '../../models';
import { base64ToBytes, bytesToUtf8, isProbablyBinary } from '../../util/decode';
import { AccessTokens } from '../access-tokens';
import { GitProvider, RepoWebLinks } from '../git-provider';
import { parseGithubUrl } from './github-url';

const PUBLIC_API_BASE = 'https://api.github.com';

/** Files above this size are not fetched; the UI links to GitHub instead. */
export const MAX_FILE_SIZE_BYTES = 2_000_000;

/** Branch pages are 100 entries; stop after this many pages and mark truncated. */
const MAX_BRANCH_PAGES = 10;

/**
 * Tag pages are 100 entries. GitHub's tag listing exposes no sort parameter
 * and no dates, so there is no way to fetch "the recent tags" specifically —
 * repositories beyond the cap return `truncated: true` and the Branch
 * Explorer says so instead of pretending the chips are complete.
 */
const MAX_TAG_PAGES = 5;

interface GithubRepoResponse {
  name: string;
  full_name: string;
  description: string | null;
  default_branch: string;
  html_url: string;
  stargazers_count: number;
  fork: boolean;
  owner: { login: string };
}

interface GithubTreeResponse {
  truncated: boolean;
  tree: {
    path: string;
    type: 'blob' | 'tree' | 'commit';
    sha: string;
    size?: number;
  }[];
}

interface GithubBlobResponse {
  sha: string;
  size: number;
  content: string;
  encoding: string;
}

interface GithubContentsResponse {
  type: string;
  path: string;
  sha: string;
  size: number;
  /** Inline base64 content; omitted/empty for files between 1 MB and 100 MB. */
  content?: string;
  encoding?: string;
}

interface GithubMatchingRefResponse {
  /** Fully qualified ref name, e.g. `refs/heads/feature/foo`. */
  ref: string;
}

interface GithubBranchResponse {
  name: string;
}

interface GithubTagResponse {
  name: string;
  /** The tagged commit (GitHub dereferences annotated tags here). */
  commit: { sha: string };
}

interface GithubCommitResponse {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name?: string; email?: string; date?: string } | null;
  };
  parents: { sha: string }[];
  /** Only present on the single-commit endpoint. */
  files?: {
    filename: string;
    status: string;
    previous_filename?: string;
    additions?: number;
    deletions?: number;
    patch?: string;
  }[];
}

/**
 * Reads repositories through GitHub's REST API. Anonymous requests to
 * github.com are limited to 60/hour per client IP; a stored personal access
 * token raises that to 5,000/hour and unlocks private repositories.
 * Rate-limit responses are mapped to a dedicated error kind so the UI can
 * explain them. The same implementation serves GitHub Enterprise Server
 * instances: when the slug carries a custom `host`, requests go to that
 * host's `/api/v3` base instead of api.github.com.
 */
@Injectable({ providedIn: 'root' })
export class GithubProvider implements GitProvider {
  readonly id = 'github';
  readonly label = 'GitHub';

  private readonly tokens = inject(AccessTokens);

  canHandle(input: string): boolean {
    return this.parseUrl(input) !== null;
  }

  parseUrl(input: string): ParsedRepoUrl | null {
    return parseGithubUrl(input);
  }

  /** Parses a repo reference on a GitHub Enterprise Server host. */
  parseHostedUrl(input: string, host: string): ParsedRepoUrl | null {
    return parseGithubUrl(input, host);
  }

  /**
   * Disambiguates the `<ref>/<path>` tail of a tree/blob URL: lists all
   * branches (then tags) starting with the first segment via the cheap
   * `matching-refs` endpoint and picks the longest one that prefixes the
   * combined string. Resolves to null on no match or any API failure.
   */
  async resolveRefPath(slug: RepoSlug, refAndPath: string): Promise<RefResolution | null> {
    const firstSegment = refAndPath.split('/', 1)[0];
    for (const namespace of ['heads', 'tags'] as const) {
      let matches: GithubMatchingRefResponse[];
      try {
        matches = await this.request<GithubMatchingRefResponse[]>(
          slug,
          `/repos/${enc(slug.owner)}/${enc(slug.repo)}/git/matching-refs/${namespace}/${enc(firstSegment)}`,
          { notFound: `No refs matching "${firstSegment}" were found.` },
        );
      } catch {
        return null;
      }
      const qualifier = `refs/${namespace}/`;
      let best: string | null = null;
      for (const match of matches) {
        if (!match.ref.startsWith(qualifier)) continue;
        const name = match.ref.slice(qualifier.length);
        if (name !== refAndPath && !refAndPath.startsWith(`${name}/`)) continue;
        if (!best || name.length > best.length) best = name;
      }
      if (best) {
        const path = refAndPath.slice(best.length + 1);
        return { ref: best, ...(path ? { path } : {}) };
      }
    }
    return null;
  }

  async getMetadata(slug: RepoSlug): Promise<RepoMetadata> {
    const data = await this.request<GithubRepoResponse>(
      slug,
      `/repos/${enc(slug.owner)}/${enc(slug.repo)}`,
      { notFound: 'Repository not found — it may not exist or it may be private.' },
    );
    return {
      owner: data.owner.login,
      name: data.name,
      fullName: data.full_name,
      description: data.description,
      defaultBranch: data.default_branch,
      htmlUrl: data.html_url,
      starCount: data.stargazers_count,
      isFork: data.fork,
    };
  }

  async listBranches(slug: RepoSlug): Promise<RepoBranchList> {
    const names: string[] = [];
    for (let page = 1; ; page++) {
      const data = await this.request<GithubBranchResponse[]>(
        slug,
        `/repos/${enc(slug.owner)}/${enc(slug.repo)}/branches?per_page=100&page=${page}`,
        { notFound: 'Repository not found — it may not exist or it may be private.' },
      );
      for (const branch of data) names.push(branch.name);
      if (data.length < 100) return { names, truncated: false };
      if (page >= MAX_BRANCH_PAGES) return { names, truncated: true };
    }
  }

  async listTags(slug: RepoSlug): Promise<RepoTagList> {
    const tags: RepoTag[] = [];
    for (let page = 1; ; page++) {
      const data = await this.request<GithubTagResponse[]>(
        slug,
        `/repos/${enc(slug.owner)}/${enc(slug.repo)}/tags?per_page=100&page=${page}`,
        { notFound: 'Repository not found — it may not exist or it may be private.' },
      );
      for (const tag of data) tags.push({ name: tag.name, sha: tag.commit.sha });
      if (data.length < 100) return { tags, truncated: false };
      if (page >= MAX_TAG_PAGES) return { tags, truncated: true };
    }
  }

  async getTree(slug: RepoSlug, ref: string): Promise<RepoTree> {
    const data = await this.request<GithubTreeResponse>(
      slug,
      `/repos/${enc(slug.owner)}/${enc(slug.repo)}/git/trees/${enc(ref)}?recursive=1`,
      { notFound: `Ref "${ref}" was not found in this repository.`, notFoundKind: 'invalid-ref' },
    );
    const entries: TreeEntry[] = data.tree.map((item) => ({
      path: item.path,
      name: item.path.slice(item.path.lastIndexOf('/') + 1),
      kind: item.type === 'blob' ? 'file' : item.type === 'tree' ? 'dir' : 'submodule',
      sha: item.sha,
      ...(item.size !== undefined ? { size: item.size } : {}),
    }));
    return { entries, truncated: data.truncated };
  }

  async getFile(slug: RepoSlug, entry: TreeEntry): Promise<RepoFile> {
    const size = entry.size ?? 0;
    if (size > MAX_FILE_SIZE_BYTES) {
      return { kind: 'too-large', path: entry.path, sha: entry.sha, size };
    }
    return this.fetchBlob(slug, entry.path, entry.sha);
  }

  async getFileAtRef(slug: RepoSlug, path: string, ref: string): Promise<RepoFile> {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const data = await this.request<GithubContentsResponse>(
      slug,
      `/repos/${enc(slug.owner)}/${enc(slug.repo)}/contents/${encodedPath}?ref=${enc(ref)}`,
      {
        notFound: `"${path}" does not exist at ${ref.slice(0, 7)} — it may have been added later or deleted by this commit.`,
      },
    );
    if (Array.isArray(data) || data.type !== 'file') {
      throw new RepoProviderError(`"${path}" is not a file at this commit.`, 'unknown');
    }
    if (data.size > MAX_FILE_SIZE_BYTES) {
      return { kind: 'too-large', path, sha: data.sha, size: data.size };
    }
    if (data.encoding === 'base64' && data.content) {
      return this.decodeBlob(path, data.sha, data.size, data.content);
    }
    // Between 1 MB and the size guard the contents API omits inline content;
    // fall back to fetching the blob it points at.
    return this.fetchBlob(slug, path, data.sha);
  }

  private async fetchBlob(slug: RepoSlug, path: string, sha: string): Promise<RepoFile> {
    const data = await this.request<GithubBlobResponse>(
      slug,
      `/repos/${enc(slug.owner)}/${enc(slug.repo)}/git/blobs/${enc(sha)}`,
      { notFound: `File "${path}" was not found.` },
    );
    if (data.encoding !== 'base64') {
      throw new RepoProviderError(
        `Unexpected blob encoding "${data.encoding}" for ${path}.`,
        'unknown',
      );
    }
    return this.decodeBlob(path, data.sha, data.size, data.content);
  }

  private decodeBlob(path: string, sha: string, size: number, base64: string): RepoFile {
    const bytes = base64ToBytes(base64);
    if (isProbablyBinary(bytes)) {
      return { kind: 'binary', path, sha, size };
    }
    return { kind: 'text', path, sha, size, text: bytesToUtf8(bytes) };
  }

  async listCommits(
    slug: RepoSlug,
    options: { ref?: string; path?: string; perPage?: number; page?: number } = {},
  ): Promise<CommitInfo[]> {
    const params = new URLSearchParams();
    if (options.ref) params.set('sha', options.ref);
    if (options.path) params.set('path', options.path);
    params.set('per_page', String(options.perPage ?? 30));
    if (options.page) params.set('page', String(options.page));

    const data = await this.request<GithubCommitResponse[]>(
      slug,
      `/repos/${enc(slug.owner)}/${enc(slug.repo)}/commits?${params}`,
      { notFound: 'No commit history found for this ref or path.' },
    );
    return data.map(mapCommit);
  }

  async getCommit(slug: RepoSlug, sha: string): Promise<CommitInfo> {
    const data = await this.request<GithubCommitResponse>(
      slug,
      `/repos/${enc(slug.owner)}/${enc(slug.repo)}/commits/${enc(sha)}`,
      { notFound: `Commit ${sha.slice(0, 7)} was not found in this repository.` },
    );
    return mapCommit(data);
  }

  async getCommitFiles(slug: RepoSlug, sha: string): Promise<CommitFileChange[]> {
    const data = await this.request<GithubCommitResponse>(
      slug,
      `/repos/${enc(slug.owner)}/${enc(slug.repo)}/commits/${enc(sha)}`,
      { notFound: `Commit ${sha.slice(0, 7)} was not found in this repository.` },
    );
    return (data.files ?? []).map((file) => ({
      path: file.filename,
      status: file.status,
      ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
      ...(file.additions !== undefined ? { additions: file.additions } : {}),
      ...(file.deletions !== undefined ? { deletions: file.deletions } : {}),
      ...(file.patch !== undefined ? { patch: file.patch } : {}),
    }));
  }

  webLinks(slug: RepoSlug, ref: string, path?: string): RepoWebLinks {
    const webBase = slug.host ? stripTrailingSlash(slug.host) : 'https://github.com';
    const repoUrl = `${webBase}/${slug.owner}/${slug.repo}`;
    if (!path) return { repoUrl };
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    // github.com serves raw blobs from a dedicated host; GitHub Enterprise
    // Server serves them from `<host>/raw/...` on the instance itself.
    const rawFileUrl = slug.host
      ? `${repoUrl}/raw/${enc(ref)}/${encodedPath}`
      : `https://raw.githubusercontent.com/${slug.owner}/${slug.repo}/${enc(ref)}/${encodedPath}`;
    return {
      repoUrl,
      fileUrl: `${repoUrl}/blob/${enc(ref)}/${encodedPath}`,
      rawFileUrl,
    };
  }

  private async request<T>(
    slug: RepoSlug,
    apiPath: string,
    messages: { notFound: string; notFoundKind?: 'not-found' | 'invalid-ref' },
  ): Promise<T> {
    const token = this.tokens.tokenForSlug(slug);
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let response: Response;
    try {
      response = await fetch(`${apiBase(slug)}${apiPath}`, { headers });
    } catch {
      throw new RepoProviderError(
        'Could not reach the GitHub API — check your connection and try again.',
        'network',
      );
    }

    if (response.ok) {
      return (await response.json()) as T;
    }

    if (
      (response.status === 403 || response.status === 429) &&
      response.headers.get('x-ratelimit-remaining') === '0'
    ) {
      const resetAt = rateLimitReset(response);
      const resetHint = resetAt
        ? ` It resets at ${resetAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
        : '';
      throw new RepoProviderError(
        token
          ? `GitHub's API rate limit for your token is exhausted.${resetHint}`
          : `GitHub's unauthenticated API rate limit (60 requests/hour per IP) is exhausted.${resetHint} A personal access token (start page) raises it to 5,000/hour.`,
        'rate-limited',
        resetAt,
      );
    }

    if (response.status === 401) {
      throw new RepoProviderError(
        'GitHub rejected the personal access token — check it on the start page, or clear it to browse anonymously.',
        'unknown',
      );
    }

    if (response.status === 404) {
      throw new RepoProviderError(messages.notFound, messages.notFoundKind ?? 'not-found');
    }

    if (response.status === 409) {
      throw new RepoProviderError('This repository is empty.', 'empty-repo');
    }

    throw new RepoProviderError(
      `GitHub API request failed with status ${response.status}.`,
      'unknown',
    );
  }
}

function rateLimitReset(response: Response): Date | undefined {
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  return Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined;
}

/**
 * The REST base for a slug: api.github.com for github.com, or the instance's
 * `/api/v3` endpoint for a GitHub Enterprise Server host.
 */
function apiBase(slug: RepoSlug): string {
  return slug.host ? `${stripTrailingSlash(slug.host)}/api/v3` : PUBLIC_API_BASE;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function mapCommit(item: GithubCommitResponse): CommitInfo {
  return {
    sha: item.sha,
    message: item.commit.message,
    summary: item.commit.message.split('\n', 1)[0],
    authorName: item.commit.author?.name ?? 'Unknown',
    authorEmail: item.commit.author?.email ?? null,
    authoredAt: item.commit.author?.date ?? '',
    htmlUrl: item.html_url,
    parentShas: item.parents.map((p) => p.sha),
  };
}
