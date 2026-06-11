import { Injectable, computed, inject, signal } from '@angular/core';

import { ProviderRegistry, RepoWebLinks } from '../git/git-provider';
import {
  CommitInfo,
  FileState,
  RepoFile,
  RepoLoadPhase,
  RepoMetadata,
  RepoProviderError,
  RepoSlug,
  TreeEntry,
  toRepoProviderError,
} from '../models';
import { FileDiff, computeFileDiff } from '../util/diff';
import { ancestorsOf, buildTree } from '../util/tree';
import { RecentRepos } from './recent-repos';

const HISTORY_PAGE_SIZE = 30;

/** Lifecycle of the per-file commit history panel. */
export type HistoryStatus = 'idle' | 'loading' | 'loading-more' | 'ready' | 'error';

/** Async state of the changes view for one `<commit, path>` pair. */
export type DiffState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly diff: FileDiff;
      readonly commit: CommitInfo;
      /** Parent commit the diff is against; null for a root commit. */
      readonly baseSha: string | null;
    }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'error'; readonly message: string };

/**
 * Single source of truth for the repository currently shown in the viewer:
 * load lifecycle, tree, expansion state, selection, per-file content cache,
 * per-file commit history, the "viewing at commit" time-travel state and
 * per-commit file diffs.
 *
 * All async flows are guarded by a load sequence number so responses that
 * arrive after the user has already navigated elsewhere are dropped.
 */
@Injectable({ providedIn: 'root' })
export class RepoStore {
  private readonly registry = inject(ProviderRegistry);
  private readonly recents = inject(RecentRepos);

  private loadSeq = 0;
  /** In-flight file fetches keyed like {@link fileKey}, to dedupe callers. */
  private readonly inflight = new Map<string, Promise<FileState>>();

  private readonly _phase = signal<RepoLoadPhase>('idle');
  private readonly _error = signal<RepoProviderError | null>(null);
  private readonly _slug = signal<RepoSlug | null>(null);
  private readonly _requestedRef = signal<string | null>(null);
  private readonly _metadata = signal<RepoMetadata | null>(null);
  private readonly _entries = signal<readonly TreeEntry[]>([]);
  private readonly _truncated = signal(false);
  private readonly _selectedPath = signal<string | null>(null);
  /** Commit sha the selected file is viewed at; null = the loaded snapshot. */
  private readonly _viewAt = signal<string | null>(null);
  /** File contents keyed by `<sha|tip>::<path>` (see {@link fileKey}). */
  private readonly _files = signal<ReadonlyMap<string, FileState>>(new Map());
  private readonly _expanded = signal<ReadonlySet<string>>(new Set());
  /** Every commit seen so far (history pages, single lookups), by sha. */
  private readonly _commitsBySha = signal<ReadonlyMap<string, CommitInfo>>(new Map());
  /** Diff states keyed by `<sha>::<path>`. */
  private readonly _diffs = signal<ReadonlyMap<string, DiffState>>(new Map());

  private readonly _historyPath = signal<string | null>(null);
  private readonly _history = signal<readonly CommitInfo[]>([]);
  private readonly _historyStatus = signal<HistoryStatus>('idle');
  private readonly _historyError = signal<string | null>(null);
  private readonly _historyHasMore = signal(false);
  private historyPage = 1;

  readonly phase = this._phase.asReadonly();
  readonly error = this._error.asReadonly();
  readonly slug = this._slug.asReadonly();
  readonly metadata = this._metadata.asReadonly();
  readonly truncated = this._truncated.asReadonly();
  readonly selectedPath = this._selectedPath.asReadonly();
  readonly viewAt = this._viewAt.asReadonly();
  readonly expandedDirs = this._expanded.asReadonly();

  readonly historyPath = this._historyPath.asReadonly();
  readonly history = this._history.asReadonly();
  readonly historyStatus = this._historyStatus.asReadonly();
  readonly historyError = this._historyError.asReadonly();
  readonly historyHasMore = this._historyHasMore.asReadonly();

  /** Ref shown in the viewer: the requested one, or the default branch. */
  readonly ref = computed(() => this._requestedRef() ?? this._metadata()?.defaultBranch ?? null);

  readonly tree = computed(() => buildTree(this._entries()));

  readonly fileCount = computed(() => this._entries().filter((e) => e.kind === 'file').length);
  readonly dirCount = computed(() => this._entries().filter((e) => e.kind === 'dir').length);

  private readonly entriesByPath = computed(() => {
    const map = new Map<string, TreeEntry>();
    for (const entry of this._entries()) map.set(entry.path, entry);
    return map;
  });

  /** State of the currently selected file at the current view ref, if any. */
  readonly selectedFile = computed<FileState | null>(() => {
    const path = this._selectedPath();
    return path ? (this._files().get(fileKey(path, this._viewAt())) ?? null) : null;
  });

  /** The commit the file is viewed at, when its metadata is known. */
  readonly viewAtCommit = computed<CommitInfo | null>(() => {
    const at = this._viewAt();
    return at ? (this._commitsBySha().get(at) ?? null) : null;
  });

  /** Diff of the selected file against its parent at the viewed commit. */
  readonly selectedDiff = computed<DiffState | null>(() => {
    const path = this._selectedPath();
    const at = this._viewAt();
    if (!path || !at) return null;
    return this._diffs().get(fileKey(path, at)) ?? null;
  });

  /**
   * Loads a repository (metadata, then full tree). No-ops when the same
   * repo+ref is already loading or loaded, unless `force` is set.
   */
  async loadRepo(
    slug: RepoSlug,
    requestedRef?: string,
    options?: { force?: boolean },
  ): Promise<void> {
    const ref = requestedRef ?? null;
    if (!options?.force && this.isCurrentTarget(slug, ref) && this._phase() !== 'error') {
      return;
    }

    const seq = ++this.loadSeq;
    this._slug.set(slug);
    this._requestedRef.set(ref);
    this._metadata.set(null);
    this._entries.set([]);
    this._truncated.set(false);
    this._selectedPath.set(null);
    this._viewAt.set(null);
    this._files.set(new Map());
    this._expanded.set(new Set());
    this._commitsBySha.set(new Map());
    this._diffs.set(new Map());
    this.inflight.clear();
    this._error.set(null);
    this.resetHistory();
    this._phase.set('metadata');

    try {
      const provider = this.registry.byId(slug.provider);
      const metadata = await provider.getMetadata(slug);
      if (seq !== this.loadSeq) return;
      this._metadata.set(metadata);
      this._phase.set('tree');

      const tree = await provider.getTree(slug, ref ?? metadata.defaultBranch);
      if (seq !== this.loadSeq) return;
      this._entries.set(tree.entries);
      this._truncated.set(tree.truncated);
      this._phase.set('ready');

      this.recents.record({
        owner: metadata.owner,
        repo: metadata.name,
        description: metadata.description,
      });
    } catch (error) {
      if (seq !== this.loadSeq) return;
      this._error.set(toRepoProviderError(error));
      this._phase.set('error');
    }
  }

  /** Re-runs the last requested load after an error. */
  retry(): void {
    const slug = this._slug();
    if (!slug) return;
    void this.loadRepo(slug, this._requestedRef() ?? undefined, { force: true });
  }

  /**
   * Selects a file (optionally at a historical commit sha), reveals it in the
   * tree and fetches its content. Content is cached per path+ref for the
   * lifetime of the loaded snapshot.
   */
  async openFile(path: string, at?: string | null): Promise<void> {
    const atRef = at ?? null;
    this._selectedPath.set(path);
    this._viewAt.set(atRef);
    this.revealPath(path);
    await this.ensureFile(path, atRef);
  }

  /**
   * Computes what the commit `at` changed in `path`: the file at the commit
   * diffed against the same path at the commit's first parent. Cached per
   * `<commit, path>`; reuses file-content caches for both sides.
   */
  async loadDiff(path: string, at: string): Promise<void> {
    const key = fileKey(path, at);
    const existing = this._diffs().get(key);
    if (existing && existing.status !== 'error') return;
    const slug = this._slug();
    if (!slug) return;

    const seq = this.loadSeq;
    this.setDiffState(key, { status: 'loading' });
    try {
      const commit = await this.resolveCommit(slug, at);
      if (seq !== this.loadSeq) return;
      const baseSha = commit.parentShas[0] ?? null;

      const [currentState, baseState] = await Promise.all([
        this.ensureFile(path, at),
        baseSha ? this.ensureFile(path, baseSha) : Promise.resolve(null),
      ]);
      if (seq !== this.loadSeq) return;

      if (currentState.status !== 'ready') {
        this.setDiffState(key, {
          status: 'error',
          message:
            currentState.status === 'error'
              ? currentState.message
              : 'The file content could not be loaded.',
        });
        return;
      }
      if (currentState.file.kind !== 'text') {
        this.setDiffState(key, {
          status: 'unavailable',
          reason:
            currentState.file.kind === 'binary'
              ? 'Binary file — no text diff.'
              : 'The file is too large to diff here.',
        });
        return;
      }

      let baseText = '';
      if (baseState) {
        if (baseState.status === 'error') {
          if (baseState.kind !== 'not-found') {
            this.setDiffState(key, { status: 'error', message: baseState.message });
            return;
          }
          // Path absent at the parent: the commit added the file; diff vs empty.
        } else if (baseState.status !== 'ready') {
          this.setDiffState(key, {
            status: 'error',
            message: 'The previous version could not be loaded.',
          });
          return;
        } else if (baseState.file.kind !== 'text') {
          this.setDiffState(key, {
            status: 'unavailable',
            reason: 'The previous version is binary or too large to diff.',
          });
          return;
        } else {
          baseText = baseState.file.text;
        }
      }

      const diff = computeFileDiff(baseText, currentState.file.text);
      this.setDiffState(key, { status: 'ready', diff, commit, baseSha });
    } catch (error) {
      if (seq !== this.loadSeq) return;
      this.setDiffState(key, { status: 'error', message: toRepoProviderError(error).message });
    }
  }

  /**
   * Loads the commit history of `path` (commits reachable from the snapshot
   * ref that touched the path). No-ops when that history is already loaded.
   * Note: like `git log -- <path>`, the listing does not follow renames —
   * that is exactly where the planned rename-candidate feature picks up.
   */
  async loadHistory(path: string): Promise<void> {
    const slug = this._slug();
    if (!slug || this._phase() !== 'ready') return;
    const status = this._historyStatus();
    if (this._historyPath() === path && status !== 'idle' && status !== 'error') return;

    const seq = this.loadSeq;
    this._historyPath.set(path);
    this._history.set([]);
    this._historyError.set(null);
    this._historyHasMore.set(false);
    this._historyStatus.set('loading');
    this.historyPage = 1;

    try {
      const commits = await this.registry.byId(slug.provider).listCommits(slug, {
        ref: this.ref() ?? undefined,
        path,
        perPage: HISTORY_PAGE_SIZE,
      });
      if (seq !== this.loadSeq || this._historyPath() !== path) return;
      this._history.set(commits);
      this.cacheCommits(commits);
      this._historyHasMore.set(commits.length === HISTORY_PAGE_SIZE);
      this._historyStatus.set('ready');
    } catch (error) {
      if (seq !== this.loadSeq || this._historyPath() !== path) return;
      this._historyError.set(toRepoProviderError(error).message);
      this._historyStatus.set('error');
    }
  }

  /** Fetches the next page of the current file's history. */
  async loadMoreHistory(): Promise<void> {
    const slug = this._slug();
    const path = this._historyPath();
    if (!slug || !path || this._historyStatus() !== 'ready' || !this._historyHasMore()) return;

    const seq = this.loadSeq;
    const page = this.historyPage + 1;
    this._historyStatus.set('loading-more');
    try {
      const commits = await this.registry.byId(slug.provider).listCommits(slug, {
        ref: this.ref() ?? undefined,
        path,
        perPage: HISTORY_PAGE_SIZE,
        page,
      });
      if (seq !== this.loadSeq || this._historyPath() !== path) return;
      this.historyPage = page;
      this._history.set([...this._history(), ...commits]);
      this.cacheCommits(commits);
      this._historyHasMore.set(commits.length === HISTORY_PAGE_SIZE);
      this._historyStatus.set('ready');
    } catch (error) {
      if (seq !== this.loadSeq || this._historyPath() !== path) return;
      // Keep the already-loaded commits; just surface the failure.
      this._historyError.set(toRepoProviderError(error).message);
      this._historyStatus.set('error');
    }
  }

  /** Forces a fresh history load after an error. */
  retryHistory(): void {
    const path = this._historyPath();
    if (!path) return;
    this._historyStatus.set('idle');
    void this.loadHistory(path);
  }

  clearSelection(): void {
    this._selectedPath.set(null);
    this._viewAt.set(null);
  }

  toggleDir(path: string): void {
    const next = new Set(this._expanded());
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    this._expanded.set(next);
  }

  /** Expands all ancestor directories so `path` is visible in the tree. */
  revealPath(path: string): void {
    const ancestors = ancestorsOf(path);
    if (ancestors.every((a) => this._expanded().has(a))) return;
    this._expanded.set(new Set([...this._expanded(), ...ancestors]));
  }

  /**
   * Outbound links for the loaded repo or one of its files, optionally at a
   * historical commit instead of the snapshot ref.
   */
  linksFor(path?: string, at?: string | null): RepoWebLinks | null {
    const slug = this._slug();
    const ref = at ?? this.ref();
    if (!slug || !ref) return null;
    return this.registry.byId(slug.provider).webLinks(slug, ref, path);
  }

  /**
   * Returns the (cached) content state of `path` at `at`, fetching it if
   * needed. Resolves with an error state instead of rejecting; concurrent
   * callers share one request.
   */
  private ensureFile(path: string, at: string | null): Promise<FileState> {
    const key = fileKey(path, at);
    const existing = this._files().get(key);
    if (existing && existing.status === 'ready') return Promise.resolve(existing);
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = this.fetchFile(path, at, key);
    this.inflight.set(key, promise);
    void promise.finally(() => this.inflight.delete(key));
    return promise;
  }

  private async fetchFile(path: string, at: string | null, key: string): Promise<FileState> {
    const slug = this._slug();
    if (!slug) {
      return { status: 'error', path, message: 'No repository is loaded.', kind: 'unknown' };
    }
    const provider = this.registry.byId(slug.provider);

    let fetcher: () => Promise<RepoFile>;
    if (at) {
      fetcher = () => provider.getFileAtRef(slug, path, at);
    } else {
      const entry = this.entriesByPath().get(path);
      if (!entry || entry.kind !== 'file') {
        const state: FileState = {
          status: 'error',
          path,
          message: 'This file does not exist at the current ref.',
          kind: 'not-found',
        };
        this.setFileState(key, state);
        return state;
      }
      fetcher = () => provider.getFile(slug, entry);
    }

    const seq = this.loadSeq;
    this.setFileState(key, { status: 'loading', path });
    try {
      const file = await fetcher();
      const state: FileState = { status: 'ready', path, file };
      if (seq === this.loadSeq) this.setFileState(key, state);
      return state;
    } catch (error) {
      const err = toRepoProviderError(error);
      const state: FileState = { status: 'error', path, message: err.message, kind: err.kind };
      if (seq === this.loadSeq) this.setFileState(key, state);
      return state;
    }
  }

  /** Commit metadata by sha, served from cache when already seen. */
  private async resolveCommit(slug: RepoSlug, sha: string): Promise<CommitInfo> {
    const cached = this._commitsBySha().get(sha);
    if (cached) return cached;
    const commit = await this.registry.byId(slug.provider).getCommit(slug, sha);
    this.cacheCommits([commit]);
    return commit;
  }

  private cacheCommits(commits: readonly CommitInfo[]): void {
    if (commits.length === 0) return;
    const next = new Map(this._commitsBySha());
    for (const commit of commits) next.set(commit.sha, commit);
    this._commitsBySha.set(next);
  }

  private resetHistory(): void {
    this._historyPath.set(null);
    this._history.set([]);
    this._historyStatus.set('idle');
    this._historyError.set(null);
    this._historyHasMore.set(false);
    this.historyPage = 1;
  }

  private isCurrentTarget(slug: RepoSlug, ref: string | null): boolean {
    const current = this._slug();
    return (
      !!current &&
      current.provider === slug.provider &&
      current.owner.toLowerCase() === slug.owner.toLowerCase() &&
      current.repo.toLowerCase() === slug.repo.toLowerCase() &&
      (this._requestedRef() ?? null) === ref
    );
  }

  private setFileState(key: string, state: FileState): void {
    const next = new Map(this._files());
    next.set(key, state);
    this._files.set(next);
  }

  private setDiffState(key: string, state: DiffState): void {
    const next = new Map(this._diffs());
    next.set(key, state);
    this._diffs.set(next);
  }
}

/**
 * Cache key for file content and diffs. The prefix is either `tip` or a
 * commit sha, so paths (which can contain anything) cannot collide across
 * refs.
 */
function fileKey(path: string, at: string | null): string {
  return `${at ?? 'tip'}::${path}`;
}
