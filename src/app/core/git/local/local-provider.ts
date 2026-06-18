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

/** A {@link ReadCommitResult} that also carries the root tree oid `log` returns. */
interface LogCommitResult extends ReadCommitResult {
  commit: ReadCommitResult['commit'] & { tree: string };
}

/** One entry of a git tree, as returned by isomorphic-git's `readTree`. */
interface TreeChild {
  path: string;
  oid: string;
  type: 'blob' | 'tree' | 'commit';
}

/** A memoised commit-log walk: the commits seen so far, newest first. */
interface CommitLogCache {
  readonly commits: readonly CommitInfo[];
  /** True when the walk reached the end of history (no deeper page exists). */
  readonly complete: boolean;
}

/** Joins ref and path for the commit-log cache; NUL can't occur in either. */
const CACHE_KEY_SEP = String.fromCharCode(0);
const logCacheKey = (ref: string, path: string): string => `${ref}${CACHE_KEY_SEP}${path}`;

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

  /**
   * Commit-log walks memoised per filesystem, then per `<ref>\0<path>`.
   * isomorphic-git's `log` can neither resume nor page — it re-walks from the
   * tip on every call, and a path filter forces a *full*-history walk every
   * time. That made paging quadratic on local repos: "Load all history" and
   * the per-file co-change walk re-walked the whole repository for each page.
   * The repo is read-only for the session, so the ordered walk is stable and
   * safe to reuse. Keying by the fs object — a re-picked or reconnected folder
   * gets a fresh one — keeps the cache from going stale; a WeakMap lets it die
   * with the fs.
   */
  private readonly logCache = new WeakMap<FsLike, Map<string, CommitLogCache>>();

  /**
   * Refs whose *every* path history has been precomputed in one pass (see
   * {@link primeHistories}), per fs. Once a ref is here, a path missing from
   * {@link logCache} has genuinely no history — no per-file walk is needed.
   */
  private readonly primedRefs = new WeakMap<FsLike, Set<string>>();

  /**
   * Tree entries by oid, per fs. Tree oids are content-addressed and immutable,
   * so a walk that revisits the same subtree across adjacent commits (the common
   * case) reads it once instead of re-parsing it. Dies with the fs via WeakMap.
   */
  private readonly treeCache = new WeakMap<FsLike, Map<string, readonly TreeChild[]>>();

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
      const commits = await this.commitLog(fs, options.ref ?? 'HEAD', options.path, page * perPage);
      return commits.slice((page - 1) * perPage, page * perPage);
    } catch (error) {
      throw this.mapError(error, 'No commit history found for this ref or path.');
    }
  }

  /**
   * At least `wanted` commits reachable from `ref` (optionally only those that
   * touched `path`), newest first, memoised per fs so repeated paging never
   * re-walks. A path filter has no shallow form in isomorphic-git — it always
   * walks the full history — so its result is cached complete and every later
   * page is a free slice. An unfiltered walk grows the cached prefix on demand
   * and never reads deeper than the request itself would have.
   */
  private async commitLog(
    fs: FsLike,
    ref: string,
    path: string | undefined,
    wanted: number,
  ): Promise<readonly CommitInfo[]> {
    let perFs = this.logCache.get(fs);
    if (!perFs) {
      perFs = new Map();
      this.logCache.set(fs, perFs);
    }
    const key = logCacheKey(ref, path ?? '');
    const cached = perFs.get(key);
    if (cached && (cached.complete || cached.commits.length >= wanted)) {
      return cached.commits;
    }
    // After a one-pass prime, every touched path is cached; a miss is empty.
    if (path && this.primedRefs.get(fs)?.has(ref)) {
      const empty: CommitLogCache = { commits: [], complete: true };
      perFs.set(key, empty);
      return empty.commits;
    }

    const git = await loadGit();
    // With a path, isomorphic-git must walk the whole history to find every
    // commit that touched it (`force` skips commits where it is absent rather
    // than throwing); without one, the walk is capped at the requested depth.
    const log = (await git.log({
      fs,
      dir: '/',
      ref,
      ...(path ? { filepath: path, force: true } : { depth: wanted }),
    })) as ReadCommitResult[];
    const commits = log.map(mapCommit);
    perFs.set(key, { commits, complete: !!path || commits.length < wanted });
    return commits;
  }

  /**
   * Precomputes the full commit history of *every* path reachable from `ref` in
   * a single walk, then serves all later `listCommits({ path })` calls from the
   * cache. Bulk consumers — the folder ownership / busfactor scan — otherwise
   * ask for hundreds of files' histories, and isomorphic-git's per-path `log`
   * re-walks the whole repository for each one: an O(files × commits) storm
   * that took many minutes. Here the history is walked once and each commit is
   * diffed against its first parent with oid-pruned tree comparison (identical
   * subtrees are skipped), so the cost is ~O(commits + changes) for the entire
   * repository. Idempotent and cached per fs+ref; safe because the repo is
   * read-only for the session.
   */
  async primeHistories(slug: RepoSlug, ref: string): Promise<void> {
    const fs = this.fs(slug);
    let primed = this.primedRefs.get(fs);
    if (primed?.has(ref)) return;

    const git = await loadGit();
    const log = (await git.log({ fs, dir: '/', ref })) as LogCommitResult[];
    const treeOf = new Map(log.map((entry) => [entry.oid, entry.commit.tree]));
    const readTree = (oid: string): Promise<readonly TreeChild[]> =>
      this.readTreeCached(git, fs, oid);

    // The log is newest-first, so appending keeps each path's history newest-first.
    const histories = new Map<string, CommitInfo[]>();
    for (const entry of log) {
      const parentOid = entry.commit.parent[0];
      const parentTree = parentOid ? (treeOf.get(parentOid) ?? null) : null;
      const changed: CommitFileChange[] = [];
      await this.diffTrees(readTree, parentTree, entry.commit.tree, '', changed);
      if (changed.length === 0) continue;
      const info = mapCommit(entry);
      for (const change of changed) {
        let arr = histories.get(change.path);
        if (!arr) histories.set(change.path, (arr = []));
        arr.push(info);
      }
    }

    let perFs = this.logCache.get(fs);
    if (!perFs) {
      perFs = new Map();
      this.logCache.set(fs, perFs);
    }
    for (const [p, commits] of histories) {
      perFs.set(logCacheKey(ref, p), { commits, complete: true });
    }
    if (!primed) this.primedRefs.set(fs, (primed = new Set()));
    primed.add(ref);
  }

  /** A tree's entries, memoised per fs+oid (see {@link treeCache}). */
  private async readTreeCached(
    git: GitApi,
    fs: FsLike,
    oid: string,
  ): Promise<readonly TreeChild[]> {
    let perFs = this.treeCache.get(fs);
    if (!perFs) this.treeCache.set(fs, (perFs = new Map()));
    let entries = perFs.get(oid);
    if (!entries) {
      entries = (await git.readTree({ fs, dir: '/', oid })).tree as TreeChild[];
      perFs.set(oid, entries);
    }
    return entries;
  }

  /**
   * Collects the file changes between two trees (a commit vs its parent),
   * recursing only into subtrees whose oids differ — identical subtrees are
   * pruned, so the work is proportional to what changed, not to the tree size.
   * A null tree means "absent" (root commit, or an added/removed subtree).
   */
  private async diffTrees(
    readTree: (oid: string) => Promise<readonly TreeChild[]>,
    aTree: string | null,
    bTree: string | null,
    prefix: string,
    out: CommitFileChange[],
  ): Promise<void> {
    if (aTree === bTree) return;
    const before = new Map<string, TreeChild>();
    if (aTree) for (const e of await readTree(aTree)) before.set(e.path, e);
    const after = bTree ? await readTree(bTree) : [];

    for (const e of after) {
      const path = prefix ? `${prefix}/${e.path}` : e.path;
      const prev = before.get(e.path);
      before.delete(e.path);
      if (e.type === 'tree') {
        // A blob replaced by a directory: the old blob is gone, its files are new.
        if (prev && prev.type !== 'tree') out.push({ path, status: 'removed' });
        await this.diffTrees(readTree, prev?.type === 'tree' ? prev.oid : null, e.oid, path, out);
      } else if (!prev) {
        out.push({ path, status: 'added' });
      } else if (prev.type === 'tree') {
        // A directory replaced by a blob: its files are gone, the blob is new.
        await this.diffTrees(readTree, prev.oid, null, path, out);
        out.push({ path, status: 'added' });
      } else if (prev.oid !== e.oid) {
        out.push({ path, status: 'modified' });
      }
    }
    // Whatever is left in `before` was removed by this commit.
    for (const e of before.values()) {
      const path = prefix ? `${prefix}/${e.path}` : e.path;
      if (e.type === 'tree') await this.diffTrees(readTree, e.oid, null, path, out);
      else out.push({ path, status: 'removed' });
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
      const parentOid = commit.parent[0];
      // Diff the two root trees with oid pruning (identical subtrees are skipped),
      // so the cost is proportional to what the commit changed — not to the whole
      // tree, as a full `git.walk` of both trees would be. This is the per-commit
      // primitive the co-change and Age walks call for every commit.
      const parentTree = parentOid
        ? (await git.readCommit({ fs, dir: '/', oid: parentOid })).commit.tree
        : null;
      const readTree = (oid: string): Promise<readonly TreeChild[]> =>
        this.readTreeCached(git, fs, oid);
      const changes: CommitFileChange[] = [];
      await this.diffTrees(readTree, parentTree, commit.tree, '', changes);
      return changes;
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
