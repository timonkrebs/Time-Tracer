import { Injectable, inject } from '@angular/core';

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
  toRepoProviderError,
} from '../../models';
import { bytesToUtf8, isProbablyBinary } from '../../util/decode';
import { GitProvider, RepoWebLinks } from '../git-provider';
import { FsLike } from './fsa-fs';
import { LocalRepos } from './local-repos';

/** Files above this size are not decoded into the viewer. */
const MAX_FILE_SIZE_BYTES = 2_000_000;

export type GitApi = typeof import('isomorphic-git').default;

/**
 * isomorphic-git's hashing stack (sha.js/safe-buffer) expects Node's
 * `Buffer` global, which browsers lack — install the polyfill before the
 * library loads. No-ops in Node (tests) where Buffer already exists.
 */
async function ensureBuffer(): Promise<void> {
  const g = globalThis as { Buffer?: unknown };
  if (g.Buffer) return;
  const mod = (await import('buffer')) as {
    Buffer?: unknown;
    default?: { Buffer?: unknown };
  };
  g.Buffer = mod.Buffer ?? mod.default?.Buffer;
}

/** isomorphic-git is ~300 kB — load it only when a local repo is opened. */
let gitModule: Promise<GitApi> | null = null;
export function loadGit(): Promise<GitApi> {
  gitModule ??= (async () => {
    await ensureBuffer();
    const m = await import('isomorphic-git');
    return (m as { default?: GitApi }).default ?? (m as unknown as GitApi);
  })();
  return gitModule;
}

interface ReadCommitResult {
  oid: string;
  commit: {
    message: string;
    parent: string[];
    author: { name: string; email: string; timestamp: number };
  };
}

/**
 * Reads repositories straight from a local folder (File System Access API)
 * by parsing the `.git` directory with isomorphic-git — no server, no
 * network, full history. Everything is read-only.
 */
@Injectable({ providedIn: 'root' })
export class LocalGitProvider implements GitProvider {
  readonly id = 'local';
  readonly label = 'Local folder';

  private readonly repos = inject(LocalRepos);

  /** Local repos are opened via the folder picker, never via URL input. */
  canHandle(): boolean {
    return false;
  }

  parseUrl(): ParsedRepoUrl | null {
    return null;
  }

  private fs(slug: RepoSlug): FsLike {
    return this.repos.fsFor(slug.repo);
  }

  async getMetadata(slug: RepoSlug): Promise<RepoMetadata> {
    const fs = this.fs(slug);
    try {
      const git = await loadGit();
      const branch = await git.currentBranch({ fs, dir: '/', fullname: false });
      return {
        owner: 'local',
        name: slug.repo,
        fullName: slug.repo,
        description: null,
        defaultBranch: branch ?? 'HEAD',
        htmlUrl: '',
        starCount: 0,
        isFork: false,
      };
    } catch (error) {
      throw this.mapError(error, 'Could not read the local repository.');
    }
  }

  async getTree(slug: RepoSlug, ref: string): Promise<RepoTree> {
    const fs = this.fs(slug);
    try {
      const git = await loadGit();
      const commitOid = await git.resolveRef({ fs, dir: '/', ref });
      const { commit } = await git.readCommit({ fs, dir: '/', oid: commitOid });
      const entries: TreeEntry[] = [];
      await this.walkTree(git, fs, commit.tree, '', entries);
      return { entries, truncated: false };
    } catch (error) {
      throw this.mapError(error, `Ref "${ref}" was not found in this repository.`, 'invalid-ref');
    }
  }

  private async walkTree(
    git: GitApi,
    fs: FsLike,
    treeOid: string,
    prefix: string,
    out: TreeEntry[],
  ): Promise<void> {
    const { tree } = await git.readTree({ fs, dir: '/', oid: treeOid });
    for (const entry of tree) {
      const path = prefix ? `${prefix}/${entry.path}` : entry.path;
      if (entry.type === 'tree') {
        out.push({ path, name: entry.path, kind: 'dir', sha: entry.oid });
        await this.walkTree(git, fs, entry.oid, path, out);
      } else if (entry.type === 'blob') {
        out.push({ path, name: entry.path, kind: 'file', sha: entry.oid });
      } else {
        out.push({ path, name: entry.path, kind: 'submodule', sha: entry.oid });
      }
    }
  }

  async getFile(slug: RepoSlug, entry: TreeEntry): Promise<RepoFile> {
    const fs = this.fs(slug);
    try {
      const git = await loadGit();
      const { blob } = await git.readBlob({ fs, dir: '/', oid: entry.sha });
      return this.toRepoFile(entry.path, entry.sha, blob);
    } catch (error) {
      throw this.mapError(error, `File "${entry.path}" was not found.`);
    }
  }

  async getFileAtRef(slug: RepoSlug, path: string, ref: string): Promise<RepoFile> {
    const fs = this.fs(slug);
    try {
      const git = await loadGit();
      const commitOid = await git.resolveRef({ fs, dir: '/', ref });
      const { blob, oid } = await git.readBlob({ fs, dir: '/', oid: commitOid, filepath: path });
      return this.toRepoFile(path, oid, blob);
    } catch (error) {
      throw this.mapError(
        error,
        `"${path}" does not exist at ${ref.slice(0, 7)} — it may have been added later or deleted by this commit.`,
      );
    }
  }

  private toRepoFile(path: string, sha: string, blob: Uint8Array): RepoFile {
    if (blob.length > MAX_FILE_SIZE_BYTES) {
      return { kind: 'too-large', path, sha, size: blob.length };
    }
    if (isProbablyBinary(blob)) {
      return { kind: 'binary', path, sha, size: blob.length };
    }
    return { kind: 'text', path, sha, size: blob.length, text: bytesToUtf8(blob) };
  }

  async listCommits(
    slug: RepoSlug,
    options: { ref?: string; path?: string; perPage?: number; page?: number } = {},
  ): Promise<CommitInfo[]> {
    const fs = this.fs(slug);
    const perPage = options.perPage ?? 30;
    const page = options.page ?? 1;
    try {
      const git = await loadGit();
      // isomorphic-git has no pagination: fetch up to the end of the
      // requested page and slice. `force` skips commits where the file is
      // absent instead of throwing on shallow oddities.
      const entries = (await git.log({
        fs,
        dir: '/',
        ref: options.ref ?? 'HEAD',
        depth: options.path ? undefined : page * perPage,
        ...(options.path ? { filepath: options.path, force: true } : {}),
      })) as ReadCommitResult[];
      return entries.slice((page - 1) * perPage, page * perPage).map(mapCommit);
    } catch (error) {
      throw this.mapError(error, 'No commit history found for this ref or path.');
    }
  }

  async getCommit(slug: RepoSlug, sha: string): Promise<CommitInfo> {
    const fs = this.fs(slug);
    try {
      const git = await loadGit();
      const result = (await git.readCommit({ fs, dir: '/', oid: sha })) as ReadCommitResult;
      return mapCommit(result);
    } catch (error) {
      throw this.mapError(error, `Commit ${sha.slice(0, 7)} was not found in this repository.`);
    }
  }

  async getCommitFiles(slug: RepoSlug, sha: string): Promise<CommitFileChange[]> {
    const fs = this.fs(slug);
    try {
      const git = await loadGit();
      const { commit } = await git.readCommit({ fs, dir: '/', oid: sha });
      const parent = commit.parent[0];
      const changes = await git.walk({
        fs,
        dir: '/',
        trees: [git.TREE({ ref: parent ?? sha }), git.TREE({ ref: sha })],
        map: async (filepath, [before, after]) => {
          if (filepath === '.') return undefined;
          const beforeType = await before?.type();
          const afterType = await after?.type();
          if (beforeType === 'tree' || afterType === 'tree') return undefined;
          const beforeOid = beforeType === 'blob' ? await before?.oid() : undefined;
          const afterOid = afterType === 'blob' ? await after?.oid() : undefined;
          if (!parent) {
            return afterOid ? { path: filepath, status: 'added' } : undefined;
          }
          if (beforeOid === afterOid) return undefined;
          if (beforeOid && !afterOid) return { path: filepath, status: 'removed' };
          if (!beforeOid && afterOid) return { path: filepath, status: 'added' };
          return { path: filepath, status: 'modified' };
        },
      });
      return (changes as (CommitFileChange | undefined)[]).filter(
        (c): c is CommitFileChange => !!c,
      );
    } catch (error) {
      throw this.mapError(error, `Commit ${sha.slice(0, 7)} was not found in this repository.`);
    }
  }

  /** Local repositories have no web pendant. */
  webLinks(): RepoWebLinks | null {
    return null;
  }

  private mapError(
    error: unknown,
    notFoundMessage: string,
    notFoundKind: 'not-found' | 'invalid-ref' = 'not-found',
  ): RepoProviderError {
    if (error instanceof RepoProviderError) return error;
    const name = (error as { code?: string; name?: string }).name ?? '';
    if (name === 'NotFoundError' || name === 'ResolveRefError') {
      return new RepoProviderError(notFoundMessage, notFoundKind);
    }
    return toRepoProviderError(error);
  }
}

function mapCommit(result: ReadCommitResult): CommitInfo {
  const message = result.commit.message;
  return {
    sha: result.oid,
    message,
    summary: message.split('\n', 1)[0],
    authorName: result.commit.author.name,
    authorEmail: result.commit.author.email || null,
    authoredAt: new Date(result.commit.author.timestamp * 1000).toISOString(),
    htmlUrl: '',
    parentShas: result.commit.parent,
  };
}
