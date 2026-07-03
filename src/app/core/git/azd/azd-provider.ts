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
import { parseAzdUrl } from './azd-url';

const API_VERSION = 'api-version=7.1';

/** Files above this size are not fetched into the viewer. */
const MAX_FILE_SIZE_BYTES = 2_000_000;

/** Branches fetched in one request; more than this marks the list truncated. */
const MAX_BRANCHES = 1000;

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

interface AzdRepoResponse {
  name: string;
  defaultBranch?: string;
  webUrl: string;
  project: { name: string };
}

interface AzdItem {
  path: string;
  objectId: string;
  gitObjectType: 'tree' | 'blob' | string;
  isFolder?: boolean;
  size?: number;
}

interface AzdCommit {
  commitId: string;
  comment: string;
  author?: { name?: string; email?: string; date?: string };
  parents?: string[];
  remoteUrl?: string;
}

interface AzdChange {
  changeType: string;
  sourceServerItem?: string;
  item: { path?: string; isFolder?: boolean; gitObjectType?: string };
}

/**
 * Reads repositories through the Azure DevOps REST API (v7.1). Anonymous
 * access works for public projects; a stored personal access token (sent
 * as Basic auth, `Code (Read)` scope) unlocks private ones. Private
 * projects answer anonymous requests with a sign-in page; that is surfaced
 * as a clear error. `owner` carries `{org}/{project}`.
 *
 * Note: Azure DevOps commit *lists* omit parent ids; the store fetches the
 * single commit when parents are needed (diffs against the first parent).
 */
@Injectable({ providedIn: 'root' })
export class AzdProvider implements GitProvider {
  readonly id = 'azd';
  readonly label = 'Azure DevOps';

  private readonly tokens = inject(AccessTokens);

  canHandle(input: string): boolean {
    return this.parseUrl(input) !== null;
  }

  parseUrl(input: string): ParsedRepoUrl | null {
    return parseAzdUrl(input);
  }

  async getMetadata(slug: RepoSlug): Promise<RepoMetadata> {
    const data = await this.requestJson<AzdRepoResponse>(`${repoApi(slug)}?${API_VERSION}`, {
      notFound: 'Repository not found — it may not exist or it may be private.',
    });
    return {
      owner: slug.owner,
      name: data.name,
      fullName: `${slug.owner}/${data.name}`,
      description: null,
      defaultBranch: (data.defaultBranch ?? 'refs/heads/main').replace(/^refs\/heads\//, ''),
      htmlUrl: data.webUrl,
      starCount: 0,
      isFork: false,
    };
  }

  async listBranches(slug: RepoSlug): Promise<RepoBranchList> {
    const data = await this.requestJson<{ value: { name: string }[] }>(
      `${repoApi(slug)}/refs?filter=heads/&$top=${MAX_BRANCHES}&${API_VERSION}`,
      { notFound: 'Repository not found — it may not exist or it may be private.' },
    );
    const names = data.value.map((ref) => ref.name.replace(/^refs\/heads\//, ''));
    return { names, truncated: names.length >= MAX_BRANCHES };
  }

  async getTree(slug: RepoSlug, ref: string): Promise<RepoTree> {
    const data = await this.requestJson<{ value: AzdItem[] }>(
      `${repoApi(slug)}/items?recursionLevel=full&${versionParams(ref)}&${API_VERSION}`,
      { notFound: `Ref "${ref}" was not found in this repository.`, notFoundKind: 'invalid-ref' },
    );
    const entries: TreeEntry[] = [];
    for (const item of data.value) {
      const path = item.path.replace(/^\//, '');
      if (!path) continue; // the root folder itself
      entries.push({
        path,
        name: path.slice(path.lastIndexOf('/') + 1),
        kind: item.isFolder || item.gitObjectType === 'tree' ? 'dir' : 'file',
        sha: item.objectId,
        ...(item.size !== undefined ? { size: item.size } : {}),
      });
    }
    if (entries.length === 0) {
      throw new RepoProviderError('This repository is empty.', 'empty-repo');
    }
    return { entries, truncated: false };
  }

  async getFile(slug: RepoSlug, entry: TreeEntry): Promise<RepoFile> {
    if ((entry.size ?? 0) > MAX_FILE_SIZE_BYTES) {
      return { kind: 'too-large', path: entry.path, sha: entry.sha, size: entry.size ?? 0 };
    }
    const bytes = await this.requestBytes(
      `${repoApi(slug)}/blobs/${encodeURIComponent(entry.sha)}?$format=octetStream&${API_VERSION}`,
      { notFound: `File "${entry.path}" was not found.` },
    );
    return this.toRepoFile(entry.path, entry.sha, bytes);
  }

  async getFileAtRef(slug: RepoSlug, path: string, ref: string): Promise<RepoFile> {
    // Two steps: item metadata for the blob id, then the raw blob. The items
    // JSON endpoint only inlines text content, so bytes go through blobs.
    const meta = await this.requestJson<AzdItem>(
      `${repoApi(slug)}/items?path=${encodeURIComponent(`/${path}`)}&${versionParams(ref)}&${API_VERSION}`,
      {
        notFound: `"${path}" does not exist at ${ref.slice(0, 7)} — it may have been added later or deleted by this commit.`,
      },
    );
    if ((meta.size ?? 0) > MAX_FILE_SIZE_BYTES) {
      return { kind: 'too-large', path, sha: meta.objectId, size: meta.size ?? 0 };
    }
    const bytes = await this.requestBytes(
      `${repoApi(slug)}/blobs/${encodeURIComponent(meta.objectId)}?$format=octetStream&${API_VERSION}`,
      { notFound: `File "${path}" was not found.` },
    );
    return this.toRepoFile(path, meta.objectId, bytes);
  }

  private toRepoFile(path: string, sha: string, bytes: Uint8Array): RepoFile {
    if (isProbablyBinary(bytes)) {
      return { kind: 'binary', path, sha, size: bytes.length };
    }
    return { kind: 'text', path, sha, size: bytes.length, text: bytesToUtf8(bytes) };
  }

  async listCommits(
    slug: RepoSlug,
    options: { ref?: string; path?: string; perPage?: number; page?: number } = {},
  ): Promise<CommitInfo[]> {
    const perPage = options.perPage ?? 30;
    const params = new URLSearchParams();
    if (options.path) params.set('searchCriteria.itemPath', `/${options.path}`);
    if (options.ref) {
      params.set('searchCriteria.itemVersion.version', options.ref);
      params.set(
        'searchCriteria.itemVersion.versionType',
        SHA_PATTERN.test(options.ref) ? 'commit' : 'branch',
      );
    }
    params.set('searchCriteria.$top', String(perPage));
    params.set('searchCriteria.$skip', String(((options.page ?? 1) - 1) * perPage));

    const data = await this.requestJson<{ value: AzdCommit[] }>(
      `${repoApi(slug)}/commits?${params}&${API_VERSION}`,
      { notFound: 'No commit history found for this ref or path.' },
    );
    return data.value.map((item) => mapCommit(item, slug));
  }

  async getCommit(slug: RepoSlug, sha: string): Promise<CommitInfo> {
    const data = await this.requestJson<AzdCommit>(
      `${repoApi(slug)}/commits/${encodeURIComponent(sha)}?${API_VERSION}`,
      { notFound: `Commit ${sha.slice(0, 7)} was not found in this repository.` },
    );
    return mapCommit(data, slug);
  }

  async getCommitFiles(slug: RepoSlug, sha: string): Promise<CommitFileChange[]> {
    const data = await this.requestJson<{ changes: AzdChange[] }>(
      `${repoApi(slug)}/commits/${encodeURIComponent(sha)}/changes?${API_VERSION}`,
      { notFound: `Commit ${sha.slice(0, 7)} was not found in this repository.` },
    );
    const files: CommitFileChange[] = [];
    for (const change of data.changes) {
      const path = change.item.path?.replace(/^\//, '');
      if (!path || change.item.isFolder || change.item.gitObjectType === 'tree') continue;
      const type = change.changeType;
      const status = type.includes('rename')
        ? 'renamed'
        : type.includes('add')
          ? 'added'
          : type.includes('delete')
            ? 'removed'
            : 'modified';
      files.push({
        path,
        status,
        ...(status === 'renamed' && change.sourceServerItem
          ? { previousPath: change.sourceServerItem.replace(/^\//, '') }
          : {}),
      });
    }
    return files;
  }

  webLinks(slug: RepoSlug, ref: string, path?: string): RepoWebLinks {
    const repoUrl = `https://dev.azure.com/${slug.owner}/_git/${encodeURIComponent(slug.repo)}`;
    if (!path) return { repoUrl };
    const version = SHA_PATTERN.test(ref) ? `GC${ref}` : `GB${ref}`;
    return {
      repoUrl,
      fileUrl: `${repoUrl}?path=${encodeURIComponent(`/${path}`)}&version=${encodeURIComponent(version)}`,
    };
  }

  private async requestJson<T>(
    url: string,
    messages: { notFound: string; notFoundKind?: 'not-found' | 'invalid-ref' },
  ): Promise<T> {
    const response = await this.fetchChecked(url, messages);
    return (await response.json()) as T;
  }

  private async requestBytes(
    url: string,
    messages: { notFound: string; notFoundKind?: 'not-found' | 'invalid-ref' },
  ): Promise<Uint8Array> {
    const response = await this.fetchChecked(url, messages);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async fetchChecked(
    url: string,
    messages: { notFound: string; notFoundKind?: 'not-found' | 'invalid-ref' },
  ): Promise<Response> {
    // A personal access token authenticates as Basic auth with an empty
    // user name — the scheme Azure DevOps documents for PATs.
    const token = this.tokens.tokenFor('azd');
    const headers: Record<string, string> = { Accept: 'application/json, */*' };
    if (token) headers['Authorization'] = `Basic ${btoa(`:${token}`)}`;

    let response: Response;
    try {
      response = await fetch(url, { headers });
    } catch {
      throw new RepoProviderError(
        'Could not reach Azure DevOps — check your connection and try again.',
        'network',
      );
    }
    // Requests without a valid session answer with a sign-in page
    // (status 203 or an HTML body) instead of a plain 401.
    const contentType = response.headers.get('content-type') ?? '';
    if (response.status === 203 || (response.ok && contentType.includes('text/html'))) {
      throw new RepoProviderError(
        token
          ? 'Azure DevOps rejected the access token — check that it is valid, not expired and has the Code (Read) scope.'
          : 'Azure DevOps asked for a sign-in — add a personal access token on the start page to open private projects.',
        'not-found',
      );
    }
    if (response.ok) return response;
    if (response.status === 401 || response.status === 403) {
      throw new RepoProviderError(
        token
          ? 'Azure DevOps rejected the access token — check that it is valid, not expired and has the Code (Read) scope.'
          : 'Azure DevOps denied anonymous access — this project is private. A personal access token (start page) can open it.',
        'not-found',
      );
    }
    if (response.status === 404) {
      throw new RepoProviderError(messages.notFound, messages.notFoundKind ?? 'not-found');
    }
    if (response.status === 429) {
      throw new RepoProviderError(
        'Azure DevOps is rate-limiting requests — wait a bit and try again.',
        'rate-limited',
      );
    }
    throw new RepoProviderError(
      `Azure DevOps request failed with status ${response.status}.`,
      'unknown',
    );
  }
}

/** `https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}` */
function repoApi(slug: RepoSlug): string {
  const ownerPath = slug.owner.split('/').map(encodeURIComponent).join('/');
  return `https://dev.azure.com/${ownerPath}/_apis/git/repositories/${encodeURIComponent(slug.repo)}`;
}

function versionParams(ref: string): string {
  const type = SHA_PATTERN.test(ref) ? 'commit' : 'branch';
  return `versionDescriptor.version=${encodeURIComponent(ref)}&versionDescriptor.versionType=${type}`;
}

function mapCommit(item: AzdCommit, slug: RepoSlug): CommitInfo {
  return {
    sha: item.commitId,
    message: item.comment,
    summary: item.comment.split('\n', 1)[0],
    authorName: item.author?.name ?? 'Unknown',
    authorEmail: item.author?.email ?? null,
    authoredAt: item.author?.date ?? '',
    htmlUrl:
      item.remoteUrl ??
      `https://dev.azure.com/${slug.owner}/_git/${encodeURIComponent(slug.repo)}/commit/${item.commitId}`,
    parentShas: item.parents ?? [],
  };
}
