import { Injectable } from '@angular/core';

import {
  CommitFileChange,
  CommitInfo,
  ParsedRepoUrl,
  RepoFile,
  RepoMetadata,
  RepoProviderError,
  RepoSlug,
  RepoTree,
  TreeEntry,
} from '../../models';
import { base64ToBytes, bytesToUtf8, isProbablyBinary } from '../../util/decode';
import { GitProvider, RepoWebLinks } from '../git-provider';
import { parseGitlabUrl } from './gitlab-url';

const API_BASE = 'https://gitlab.com/api/v4';

/** Files above this size are not fetched; the UI links to GitLab instead. */
const MAX_FILE_SIZE_BYTES = 2_000_000;

/** Tree pages are 100 entries; stop after this many pages and mark truncated. */
const MAX_TREE_PAGES = 50;

interface GitlabProjectResponse {
  path: string;
  path_with_namespace: string;
  description: string | null;
  default_branch: string;
  web_url: string;
  star_count: number;
  forked_from_project?: unknown;
  namespace: { full_path: string };
}

interface GitlabTreeItem {
  id: string;
  name: string;
  type: 'tree' | 'blob' | 'commit';
  path: string;
}

interface GitlabFileResponse {
  blob_id: string;
  size: number;
  encoding: string;
  content: string;
}

interface GitlabCommitResponse {
  id: string;
  message: string;
  title: string;
  author_name: string;
  author_email: string | null;
  authored_date: string;
  web_url: string;
  parent_ids: string[];
}

interface GitlabDiffItem {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
}

/**
 * Reads public repositories through GitLab.com's unauthenticated REST API
 * (v4). Projects are addressed by their URL-encoded full path, which also
 * covers nested groups.
 */
@Injectable({ providedIn: 'root' })
export class GitlabProvider implements GitProvider {
  readonly id = 'gitlab';
  readonly label = 'GitLab';

  canHandle(input: string): boolean {
    return this.parseUrl(input) !== null;
  }

  parseUrl(input: string): ParsedRepoUrl | null {
    return parseGitlabUrl(input);
  }

  async getMetadata(slug: RepoSlug): Promise<RepoMetadata> {
    const data = await this.request<GitlabProjectResponse>(`/projects/${projectId(slug)}`, {
      notFound: 'Project not found — it may not exist or it may be private.',
    });
    return {
      owner: data.namespace.full_path,
      name: data.path,
      fullName: data.path_with_namespace,
      description: data.description,
      defaultBranch: data.default_branch,
      htmlUrl: data.web_url,
      starCount: data.star_count,
      isFork: data.forked_from_project !== undefined,
    };
  }

  async getTree(slug: RepoSlug, ref: string): Promise<RepoTree> {
    const entries: TreeEntry[] = [];
    let truncated = false;
    for (let page = 1; ; page++) {
      const items = await this.request<GitlabTreeItem[]>(
        `/projects/${projectId(slug)}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(ref)}`,
        { notFound: `Ref "${ref}" was not found in this project.`, notFoundKind: 'invalid-ref' },
      );
      for (const item of items) {
        entries.push({
          path: item.path,
          name: item.name,
          kind: item.type === 'blob' ? 'file' : item.type === 'tree' ? 'dir' : 'submodule',
          sha: item.id,
        });
      }
      if (items.length < 100) break;
      if (page >= MAX_TREE_PAGES) {
        truncated = true;
        break;
      }
    }
    if (entries.length === 0) {
      // GitLab answers an empty repository with an empty tree, not an error.
      throw new RepoProviderError('This repository is empty.', 'empty-repo');
    }
    return { entries, truncated };
  }

  async getFile(slug: RepoSlug, entry: TreeEntry): Promise<RepoFile> {
    const data = await this.request<GitlabFileResponse>(
      `/projects/${projectId(slug)}/repository/blobs/${encodeURIComponent(entry.sha)}`,
      { notFound: `File "${entry.path}" was not found.` },
    );
    return this.decodeBlob(entry.path, entry.sha, data);
  }

  async getFileAtRef(slug: RepoSlug, path: string, ref: string): Promise<RepoFile> {
    const data = await this.request<GitlabFileResponse>(
      `/projects/${projectId(slug)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
      {
        notFound: `"${path}" does not exist at ${ref.slice(0, 7)} — it may have been added later or deleted by this commit.`,
      },
    );
    return this.decodeBlob(path, data.blob_id, data);
  }

  private decodeBlob(path: string, sha: string, data: GitlabFileResponse): RepoFile {
    if (data.size > MAX_FILE_SIZE_BYTES) {
      return { kind: 'too-large', path, sha, size: data.size };
    }
    if (data.encoding !== 'base64') {
      throw new RepoProviderError(`Unexpected encoding "${data.encoding}" for ${path}.`, 'unknown');
    }
    const bytes = base64ToBytes(data.content);
    if (isProbablyBinary(bytes)) {
      return { kind: 'binary', path, sha, size: data.size };
    }
    return { kind: 'text', path, sha, size: data.size, text: bytesToUtf8(bytes) };
  }

  async listCommits(
    slug: RepoSlug,
    options: { ref?: string; path?: string; perPage?: number; page?: number } = {},
  ): Promise<CommitInfo[]> {
    const params = new URLSearchParams();
    if (options.ref) params.set('ref_name', options.ref);
    if (options.path) params.set('path', options.path);
    params.set('per_page', String(options.perPage ?? 30));
    if (options.page) params.set('page', String(options.page));

    const data = await this.request<GitlabCommitResponse[]>(
      `/projects/${projectId(slug)}/repository/commits?${params}`,
      { notFound: 'No commit history found for this ref or path.' },
    );
    return data.map(mapCommit);
  }

  async getCommit(slug: RepoSlug, sha: string): Promise<CommitInfo> {
    const data = await this.request<GitlabCommitResponse>(
      `/projects/${projectId(slug)}/repository/commits/${encodeURIComponent(sha)}`,
      { notFound: `Commit ${sha.slice(0, 7)} was not found in this project.` },
    );
    return mapCommit(data);
  }

  async getCommitFiles(slug: RepoSlug, sha: string): Promise<CommitFileChange[]> {
    const data = await this.request<GitlabDiffItem[]>(
      `/projects/${projectId(slug)}/repository/commits/${encodeURIComponent(sha)}/diff`,
      { notFound: `Commit ${sha.slice(0, 7)} was not found in this project.` },
    );
    return data.map((item) => ({
      path: item.new_path,
      status: item.new_file
        ? 'added'
        : item.deleted_file
          ? 'removed'
          : item.renamed_file
            ? 'renamed'
            : 'modified',
      ...(item.renamed_file && item.old_path !== item.new_path
        ? { previousPath: item.old_path }
        : {}),
    }));
  }

  webLinks(slug: RepoSlug, ref: string, path?: string): RepoWebLinks {
    const repoUrl = `https://gitlab.com/${slug.owner}/${slug.repo}`;
    if (!path) return { repoUrl };
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const encodedRef = encodeURIComponent(ref);
    return {
      repoUrl,
      fileUrl: `${repoUrl}/-/blob/${encodedRef}/${encodedPath}`,
      rawFileUrl: `${repoUrl}/-/raw/${encodedRef}/${encodedPath}`,
    };
  }

  private async request<T>(
    apiPath: string,
    messages: { notFound: string; notFoundKind?: 'not-found' | 'invalid-ref' },
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${apiPath}`);
    } catch {
      throw new RepoProviderError(
        'Could not reach the GitLab API — check your connection and try again.',
        'network',
      );
    }

    if (response.ok) {
      return (await response.json()) as T;
    }
    if (response.status === 429) {
      throw new RepoProviderError(
        'GitLab is rate-limiting unauthenticated requests — wait a bit and try again.',
        'rate-limited',
      );
    }
    if (response.status === 404) {
      throw new RepoProviderError(messages.notFound, messages.notFoundKind ?? 'not-found');
    }
    throw new RepoProviderError(
      `GitLab API request failed with status ${response.status}.`,
      'unknown',
    );
  }
}

function projectId(slug: RepoSlug): string {
  return encodeURIComponent(`${slug.owner}/${slug.repo}`);
}

function mapCommit(item: GitlabCommitResponse): CommitInfo {
  return {
    sha: item.id,
    message: item.message,
    summary: item.title || item.message.split('\n', 1)[0],
    authorName: item.author_name,
    authorEmail: item.author_email ?? null,
    authoredAt: item.authored_date,
    htmlUrl: item.web_url,
    parentShas: item.parent_ids,
  };
}
