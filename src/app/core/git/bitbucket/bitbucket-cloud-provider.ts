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
  RepoTag,
  RepoTagList,
  RepoTree,
  TreeEntry,
} from '../../models';
import { bytesToUtf8, isProbablyBinary } from '../../util/decode';
import { AccessTokens } from '../access-tokens';
import { GitProvider, RepoWebLinks } from '../git-provider';
import { bitbucketAuthHeader } from './bitbucket-auth';
import { parseBitbucketCloudUrl } from './bitbucket-cloud-url';

const API_BASE = 'https://api.bitbucket.org/2.0';

/** Files above this size are not fetched; the UI links to Bitbucket instead. */
const MAX_FILE_SIZE_BYTES = 2_000_000;

/** Listings page at 100 entries; stop after this many pages and mark truncated. */
const MAX_PAGES = 100;

/** Branch pages are 100 entries; stop after this many pages and mark truncated. */
const MAX_BRANCH_PAGES = 10;

/** Tag pages are 100 entries; sorted newest-tagged first. */
const MAX_TAG_PAGES = 3;

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

interface BbPaged<T> {
  values?: T[];
  next?: string;
}

interface BbRepo {
  slug: string;
  name: string;
  full_name: string;
  description: string | null;
  mainbranch?: { name: string };
  links?: { html?: { href?: string } };
  parent?: unknown;
}

interface BbSrcEntry {
  path: string;
  type: 'commit_file' | 'commit_directory' | string;
  size?: number;
  commit?: { hash?: string };
}

interface BbCommit {
  hash: string;
  message?: string;
  date?: string;
  author?: { raw?: string; user?: { display_name?: string; nickname?: string } };
  parents?: { hash: string }[];
  links?: { html?: { href?: string } };
}

interface BbDiffStat {
  status: string;
  old: { path?: string } | null;
  new: { path?: string } | null;
}

/**
 * Reads repositories through Bitbucket Cloud's REST API (2.0). Anonymous
 * access works for public repositories; a stored token unlocks private ones
 * and raises rate limits — either a repository/workspace access token (sent
 * as Bearer) or a `user:app_password` pair (sent as Basic).
 *
 * Bitbucket addresses file content by `<commit>/<path>` rather than by blob
 * sha, so tree entries carry the resolved tree commit as their `sha` (used
 * only to fetch content); the blob-identity rename shortcut other providers
 * get is unavailable here and falls back to content similarity.
 */
@Injectable({ providedIn: 'root' })
export class BitbucketCloudProvider implements GitProvider {
  readonly id = 'bitbucket';
  readonly label = 'Bitbucket';

  private readonly tokens = inject(AccessTokens);

  canHandle(input: string): boolean {
    return this.parseUrl(input) !== null;
  }

  parseUrl(input: string): ParsedRepoUrl | null {
    return parseBitbucketCloudUrl(input);
  }

  async getMetadata(slug: RepoSlug): Promise<RepoMetadata> {
    const data = await this.getJson<BbRepo>(slug, `${repoApi(slug)}`, {
      notFound: 'Repository not found — it may not exist or it may be private.',
    });
    return {
      owner: slug.owner,
      name: data.slug || data.name,
      fullName: data.full_name || `${slug.owner}/${data.slug || data.name}`,
      description: data.description ?? null,
      defaultBranch: data.mainbranch?.name ?? 'main',
      htmlUrl: data.links?.html?.href ?? `https://bitbucket.org/${slug.owner}/${slug.repo}`,
      starCount: 0,
      isFork: data.parent !== undefined,
    };
  }

  async listBranches(slug: RepoSlug): Promise<RepoBranchList> {
    const names: string[] = [];
    let url = `${repoApi(slug)}/refs/branches?pagelen=100&sort=name`;
    for (let page = 1; ; page++) {
      const data = await this.getJson<BbPaged<{ name: string }>>(slug, url, {
        notFound: 'Repository not found — it may not exist or it may be private.',
      });
      for (const branch of data.values ?? []) names.push(branch.name);
      if (!data.next) return { names, truncated: false };
      if (page >= MAX_BRANCH_PAGES) return { names, truncated: true };
      url = data.next;
    }
  }

  async listTags(slug: RepoSlug): Promise<RepoTagList> {
    const tags: RepoTag[] = [];
    let url = `${repoApi(slug)}/refs/tags?pagelen=100&sort=-target.date`;
    for (let page = 1; ; page++) {
      const data = await this.getJson<
        BbPaged<{ name: string; target?: { hash?: string; type?: string } }>
      >(slug, url, { notFound: 'Repository not found — it may not exist or it may be private.' });
      for (const tag of data.values ?? []) {
        // Bitbucket reports the tagged commit as `target` (annotated-tag
        // metadata lives in message/tagger). Guard anyway: a hash-less entry,
        // or a target something other than a commit, must not put a
        // non-commit sha on the chip map.
        const target = tag.target;
        if (!target?.hash || (target.type !== undefined && target.type !== 'commit')) continue;
        tags.push({ name: tag.name, sha: target.hash });
      }
      if (!data.next) return { tags, truncated: false };
      if (page >= MAX_TAG_PAGES) return { tags, truncated: true };
      url = data.next;
    }
  }

  /**
   * Commit hashes for slash-containing ref names, per `<owner>/<repo>@<ref>`.
   * The `/src` and `/filehistory` endpoints address the revision in a path
   * segment and decode `%2F` before routing, so a branch or tag named with a
   * slash (`feature/foo`) gets cut at the slash and fails. The `refs/…`
   * endpoints do accept the encoded name, so such refs are resolved to their
   * target hash first (see {@link resolveSlashRef}); memoised because the
   * per-file history calls would otherwise re-resolve on every request.
   */
  private readonly slashRefCache = new Map<string, Promise<string>>();

  /** Resolves a slash-containing branch/tag name to its commit hash; other refs pass through. */
  private resolveSlashRef(slug: RepoSlug, ref: string): Promise<string> {
    if (!ref.includes('/')) return Promise.resolve(ref);
    const key = `${slug.owner}/${slug.repo}@${ref}`;
    let resolved = this.slashRefCache.get(key);
    if (!resolved) {
      resolved = this.lookupSlashRef(slug, ref);
      this.slashRefCache.set(key, resolved);
      // A failed lookup must not stick — a retry should ask again.
      resolved.catch(() => this.slashRefCache.delete(key));
    }
    return resolved;
  }

  private async lookupSlashRef(slug: RepoSlug, ref: string): Promise<string> {
    const encoded = encodeURIComponent(ref);
    const messages = {
      notFound: `Ref "${ref}" was not found in this repository.`,
      notFoundKind: 'invalid-ref' as const,
    };
    try {
      const branch = await this.getJson<{ target?: { hash?: string } }>(
        slug,
        `${repoApi(slug)}/refs/branches/${encoded}`,
        messages,
      );
      if (branch.target?.hash) return branch.target.hash;
    } catch {
      // Not a branch — a tag name can carry a slash too (release/1.0).
    }
    const tag = await this.getJson<{ target?: { hash?: string } }>(
      slug,
      `${repoApi(slug)}/refs/tags/${encoded}`,
      messages,
    );
    return tag.target?.hash ?? ref;
  }

  async getTree(slug: RepoSlug, ref: string): Promise<RepoTree> {
    const target = await this.resolveSlashRef(slug, ref);
    const entries: TreeEntry[] = [];
    let resolvedCommit = SHA_PATTERN.test(target) ? target : '';
    let url =
      `${repoApi(slug)}/src/${encodeURIComponent(target)}/` + `?max_depth=${MAX_PAGES}&pagelen=100`;
    let truncated = false;

    for (let page = 1; ; page++) {
      const data = await this.getJson<BbPaged<BbSrcEntry>>(slug, url, {
        notFound: `Ref "${ref}" was not found in this repository.`,
        notFoundKind: 'invalid-ref',
      });
      const values = data.values ?? [];
      if (!resolvedCommit) {
        resolvedCommit = values.find((v) => v.commit?.hash)?.commit?.hash ?? target;
      }
      for (const item of values) {
        const path = item.path.replace(/^\//, '');
        if (!path) continue;
        entries.push({
          path,
          name: path.slice(path.lastIndexOf('/') + 1),
          kind:
            item.type === 'commit_file'
              ? 'file'
              : item.type === 'commit_directory'
                ? 'dir'
                : 'submodule',
          // Bitbucket exposes no blob sha; carry the tree commit so getFile can
          // fetch `<commit>/<path>` (see the class note).
          sha: resolvedCommit,
          ...(item.size !== undefined ? { size: item.size } : {}),
        });
      }
      if (!data.next) break;
      if (page >= MAX_PAGES) {
        truncated = true;
        break;
      }
      url = data.next;
    }

    if (entries.length === 0) {
      throw new RepoProviderError('This repository is empty.', 'empty-repo');
    }
    return { entries, truncated };
  }

  async getFile(slug: RepoSlug, entry: TreeEntry): Promise<RepoFile> {
    if ((entry.size ?? 0) > MAX_FILE_SIZE_BYTES) {
      return { kind: 'too-large', path: entry.path, sha: entry.sha, size: entry.size ?? 0 };
    }
    return this.fetchSource(slug, entry.path, entry.sha);
  }

  async getFileAtRef(slug: RepoSlug, path: string, ref: string): Promise<RepoFile> {
    return this.fetchSource(slug, path, ref);
  }

  private async fetchSource(slug: RepoSlug, path: string, commit: string): Promise<RepoFile> {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const response = await this.fetchChecked(
      slug,
      `${repoApi(slug)}/src/${encodeURIComponent(commit)}/${encodedPath}`,
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
    const ref = options.ref ? await this.resolveSlashRef(slug, options.ref) : '';
    const params = new URLSearchParams({ pagelen: String(perPage) });
    if (options.page) params.set('page', String(options.page));

    // File history needs the dedicated endpoint; otherwise list the ref's commits.
    const url = options.path
      ? `${repoApi(slug)}/filehistory/${encodeURIComponent(ref)}/${options.path
          .split('/')
          .map(encodeURIComponent)
          .join('/')}?${params}`
      : `${repoApi(slug)}/commits/${encodeURIComponent(ref)}?${params}`;

    const data = await this.getJson<BbPaged<BbCommit | { commit: BbCommit }>>(slug, url, {
      notFound: 'No commit history found for this ref or path.',
    });
    return (data.values ?? []).map((value) =>
      mapCommit('commit' in value ? value.commit : value, slug),
    );
  }

  async getCommit(slug: RepoSlug, sha: string): Promise<CommitInfo> {
    const data = await this.getJson<BbCommit>(
      slug,
      `${repoApi(slug)}/commit/${encodeURIComponent(sha)}`,
      {
        notFound: `Commit ${sha.slice(0, 7)} was not found in this repository.`,
      },
    );
    return mapCommit(data, slug);
  }

  async getCommitFiles(slug: RepoSlug, sha: string): Promise<CommitFileChange[]> {
    const files: CommitFileChange[] = [];
    let url = `${repoApi(slug)}/diffstat/${encodeURIComponent(sha)}?pagelen=100`;
    for (let page = 1; ; page++) {
      const data = await this.getJson<BbPaged<BbDiffStat>>(slug, url, {
        notFound: `Commit ${sha.slice(0, 7)} was not found in this repository.`,
      });
      for (const item of data.values ?? []) {
        const path = item.new?.path ?? item.old?.path;
        if (!path) continue;
        const status =
          item.status === 'added'
            ? 'added'
            : item.status === 'removed'
              ? 'removed'
              : item.status === 'renamed'
                ? 'renamed'
                : 'modified';
        files.push({
          path,
          status,
          ...(status === 'renamed' && item.old?.path && item.old.path !== path
            ? { previousPath: item.old.path }
            : {}),
        });
      }
      if (!data.next || page >= MAX_PAGES) break;
      url = data.next;
    }
    return files;
  }

  webLinks(slug: RepoSlug, ref: string, path?: string): RepoWebLinks {
    const repoUrl = `https://bitbucket.org/${slug.owner}/${slug.repo}`;
    if (!path) return { repoUrl };
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const encodedRef = encodeURIComponent(ref);
    return {
      repoUrl,
      fileUrl: `${repoUrl}/src/${encodedRef}/${encodedPath}`,
      rawFileUrl: `${repoUrl}/raw/${encodedRef}/${encodedPath}`,
    };
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
        'Could not reach Bitbucket — check your connection and try again.',
        'network',
      );
    }

    if (response.ok) return response;
    if (response.status === 401 || response.status === 403) {
      throw new RepoProviderError(
        auth
          ? 'Bitbucket rejected the access token — check that it is valid and has Repositories: Read.'
          : 'Bitbucket denied anonymous access — this repository is private. A token (start page) can open it.',
        'not-found',
      );
    }
    if (response.status === 404) {
      throw new RepoProviderError(messages.notFound, messages.notFoundKind ?? 'not-found');
    }
    if (response.status === 429) {
      throw new RepoProviderError(
        'Bitbucket is rate-limiting requests — wait a bit and try again.',
        'rate-limited',
      );
    }
    throw new RepoProviderError(
      `Bitbucket request failed with status ${response.status}.`,
      'unknown',
    );
  }
}

/** `https://api.bitbucket.org/2.0/repositories/{workspace}/{repo}` */
function repoApi(slug: RepoSlug): string {
  return `${API_BASE}/repositories/${encodeURIComponent(slug.owner)}/${encodeURIComponent(slug.repo)}`;
}

function mapCommit(item: BbCommit, slug: RepoSlug): CommitInfo {
  const message = item.message ?? '';
  const { name, email } = parseAuthor(item);
  return {
    sha: item.hash,
    message,
    summary: message.split('\n', 1)[0],
    authorName: name,
    authorEmail: email,
    authoredAt: item.date ?? '',
    htmlUrl:
      item.links?.html?.href ??
      `https://bitbucket.org/${slug.owner}/${slug.repo}/commits/${item.hash}`,
    parentShas: (item.parents ?? []).map((p) => p.hash),
  };
}

/** Resolves an author name/email from Bitbucket's `user` object or raw header. */
function parseAuthor(item: BbCommit): { name: string; email: string | null } {
  const raw = item.author?.raw ?? '';
  const match = raw.match(/^(.*?)\s*<([^>]*)>\s*$/);
  const display = item.author?.user?.display_name?.trim() || item.author?.user?.nickname?.trim();
  const name = display || (match ? match[1].trim() : raw.trim()) || 'Unknown';
  const email = match && match[2].trim() ? match[2].trim() : null;
  return { name, email };
}
