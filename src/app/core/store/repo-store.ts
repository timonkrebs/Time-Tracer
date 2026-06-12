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
import { FileDiff, computeFileDiff, diffLines, splitLines } from '../util/diff';
import { LineRange, changeRegions, mapRangeToParent, regionTouchesRange } from '../util/line-range';
import { findBlockOrigin, fuzzyLineSimilarity } from '../util/similarity';
import { ancestorsOf, buildTree } from '../util/tree';
import { RecentRepos } from './recent-repos';

const HISTORY_PAGE_SIZE = 30;
/** Files the creating commit deleted that get a content comparison. */
const RENAME_DELETED_CAP = 8;
/** Files compared per hunk-origin search, by scope. */
const ORIGIN_COMMIT_CAP = 20;
const ORIGIN_SNAPSHOT_CAP = 30;
/** Hunk-origin candidates kept after ranking. */
const ORIGIN_RESULT_CAP = 8;

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
 * Who introduced a line: a commit (with the line's position in the file as
 * of that commit — the hook for hunk-targeted time travel), `'older'`
 * (predates the loaded history pages) or null (still being computed).
 */
export type BlameOwner = { readonly commit: CommitInfo; readonly line: number } | 'older' | null;

/** A possible predecessor of a file whose recorded history ended. */
export interface RenameCandidate {
  readonly path: string;
  /** Blob sha of the candidate at the parent commit. */
  readonly sha: string;
  readonly size?: number;
  /** 0..1 — how likely this is the same file under an earlier name. */
  readonly confidence: number;
  readonly reasons: readonly (
    | 'github-rename'
    | 'deleted-in-commit'
    | 'identical-content'
    | 'similar-content'
    | 'heuristic'
  )[];
}

/** Async state of the rename-candidate search for one path. */
export type RenameState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly candidates: readonly RenameCandidate[];
      /** Parent of the commit that created the path — where candidates live. */
      readonly parentSha: string;
      /** The oldest known commit of the path (its apparent creation). */
      readonly endCommit: CommitInfo;
    }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'error'; readonly message: string };

/** Async state of the blame annotations for one `<version, path>` pair. */
export interface BlameState {
  readonly status: 'computing' | 'ready' | 'unavailable' | 'error';
  /** One owner per line of the blamed version (empty until computing). */
  readonly lines: readonly BlameOwner[];
  /** True when some lines predate the loaded history pages. */
  readonly truncated: boolean;
  /** History steps consumed so far — used to extend after loading more. */
  readonly processed: number;
  readonly message?: string;
}

/**
 * Async state of the per-hunk history filter: a line range anchored at one
 * version, followed backwards through the file's history (the moral
 * equivalent of `git log -L`). Only commits whose diff touched the tracked
 * range are collected.
 */
export interface LineTraceState {
  readonly status: 'computing' | 'ready' | 'error';
  readonly path: string;
  /** Commit whose version the range coordinates refer to. */
  readonly anchorSha: string;
  /** 1-based inclusive line range at the anchor version. */
  readonly range: LineRange;
  /** Commits that changed lines inside the tracked range, newest first. */
  readonly commits: readonly CommitInfo[];
  /** History steps examined so far — progress feedback while computing. */
  readonly scanned: number;
  /** True when the walk paused at the end of the loaded history pages. */
  readonly truncated: boolean;
  /**
   * Where the walk ended: the commit that introduced the tracked lines and
   * the range in that version's coordinates. Null while computing, after an
   * error and while the trail is truncated.
   */
  readonly origin: { readonly sha: string; readonly range: LineRange } | null;
  readonly message?: string;
}

/** Search space of a hunk-origin search. */
export type HunkOriginScope = 'commit' | 'snapshot';

/** A place the traced lines may have moved from, at the parent commit. */
export interface HunkOriginCandidate {
  readonly path: string;
  /** 1-based line of the best match, in the file at {@link parentSha}. */
  readonly line: number;
  /** 0..1 — how much of the traced block matches there. */
  readonly score: number;
  /** True when the introducing commit deleted this file. */
  readonly deleted: boolean;
  /** The searched repo state: the introducing commit's first parent. */
  readonly parentSha: string;
}

/**
 * Async state of the hunk-origin search: where did a trace's introduced
 * lines come from? Searches the introducing commit's other files
 * (`'commit'` scope) or the whole snapshot just before it (`'snapshot'`).
 */
export interface HunkOriginState {
  readonly status: 'searching' | 'ready' | 'unavailable' | 'error';
  readonly scope: HunkOriginScope;
  readonly candidates: readonly HunkOriginCandidate[];
  /** Files compared so far / to compare, for progress feedback. */
  readonly scanned: number;
  readonly total: number;
  /** True when the candidate file list was cut at the search cap. */
  readonly capped: boolean;
  readonly message?: string;
}

interface HistorySnapshot {
  commits: readonly CommitInfo[];
  hasMore: boolean;
  page: number;
}

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
  /** Blame states keyed by `<sha|tip>::<path>`. */
  private readonly _blames = signal<ReadonlyMap<string, BlameState>>(new Map());
  /** Blame computations currently running, by the same key. */
  private readonly blameRuns = new Set<string>();
  /** Loaded history per path, so re-selecting a file does not refetch. */
  private readonly historyCache = new Map<string, HistorySnapshot>();
  /** Full trees by commit sha, for rename-candidate searches. */
  private readonly treeCache = new Map<string, Promise<readonly TreeEntry[]>>();
  /** Rename-candidate search states keyed by path. */
  private readonly _renames = signal<ReadonlyMap<string, RenameState>>(new Map());

  private readonly _historyPath = signal<string | null>(null);
  private readonly _history = signal<readonly CommitInfo[]>([]);
  private readonly _historyStatus = signal<HistoryStatus>('idle');
  private readonly _historyError = signal<string | null>(null);
  private readonly _historyHasMore = signal(false);
  private historyPage = 1;

  /** The active per-hunk history filter, if any (one at a time). */
  private readonly _lineTrace = signal<LineTraceState | null>(null);
  /** Bumped to cancel a superseded or cleared trace walk. */
  private traceRun = 0;
  /** Where a truncated trace walk continues once more history is loaded. */
  private traceResume: { index: number; range: LineRange } | null = null;
  /** Origin search of the active trace, if started. */
  private readonly _traceOrigins = signal<HunkOriginState | null>(null);
  /** Bumped to cancel a superseded or cleared origin search. */
  private originRun = 0;

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
  readonly lineTrace = this._lineTrace.asReadonly();
  readonly traceOrigins = this._traceOrigins.asReadonly();

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

  /** Blame of the selected file at the current view ref, if requested. */
  readonly selectedBlame = computed<BlameState | null>(() => {
    const path = this._selectedPath();
    if (!path) return null;
    return this._blames().get(fileKey(path, this._viewAt())) ?? null;
  });

  /**
   * Blame state of an arbitrary version (signal-backed, reactive in
   * computeds) — the split changes view reads both sides through this.
   */
  blameFor(path: string | null, at: string | null): BlameState | null {
    if (!path) return null;
    return this._blames().get(fileKey(path, at)) ?? null;
  }

  /** Rename-candidate search state for the selected file, if started. */
  readonly selectedRenames = computed<RenameState | null>(() => {
    const path = this._selectedPath();
    return path ? (this._renames().get(path) ?? null) : null;
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
    this._blames.set(new Map());
    this._renames.set(new Map());
    this.blameRuns.clear();
    this.historyCache.clear();
    this.treeCache.clear();
    this.inflight.clear();
    this._error.set(null);
    this.resetHistory();
    this.clearLineTrace();
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
        provider: slug.provider,
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
    // The hunk filter belongs to one file's timeline; switching files ends it.
    const trace = this._lineTrace();
    if (trace && trace.path !== path) this.clearLineTrace();
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
   * Attributes every line of `path` (at `at`, or the snapshot tip) to the
   * commit that introduced it, by walking the file's history pairwise with
   * the minimal line diff: lines added in `diff(version@older, version@newer)`
   * belong to `newer`; surviving lines are traced further back.
   *
   * Progressive: attribution lands newest-commits-first and is published
   * after every step. Costs one (cached) request per history step, so the
   * walk stops early once every line is attributed. Lines older than the
   * loaded history pages are marked `'older'` and resolved incrementally
   * when more history is loaded.
   */
  async loadBlame(path: string, at?: string | null): Promise<void> {
    const atRef = at ?? null;
    const key = fileKey(path, atRef);
    if (this.blameRuns.has(key)) return;

    const existing = this._blames().get(key);
    if (existing) {
      if (existing.status === 'unavailable') return;
      if (existing.status === 'ready' && !existing.truncated) return;
      if (
        existing.status === 'ready' &&
        existing.truncated &&
        !this.canExtendBlame(path, atRef, existing)
      ) {
        return;
      }
      // error / interrupted-computing / extendable: recompute (caches make
      // already-walked steps free).
    }
    if (!this._slug() || this._phase() !== 'ready') return;

    this.blameRuns.add(key);
    try {
      await this.runBlame(key, path, atRef);
    } finally {
      this.blameRuns.delete(key);
    }
  }

  private canExtendBlame(path: string, at: string | null, state: BlameState): boolean {
    if (this._historyPath() !== path || this._historyStatus() !== 'ready') return false;
    const history = this._history();
    const anchor = at ? history.findIndex((c) => c.sha === at) : 0;
    if (anchor === -1) return false;
    return history.length - anchor > state.processed;
  }

  private async runBlame(key: string, path: string, at: string | null): Promise<void> {
    const seq = this.loadSeq;
    const fail = (status: 'unavailable' | 'error', message: string): void =>
      this.setBlameState(key, { status, lines: [], truncated: false, processed: 0, message });

    await this.loadHistory(path);
    if (seq !== this.loadSeq) return;
    if (this._historyPath() !== path || this._historyStatus() !== 'ready') {
      fail('error', this._historyError() ?? 'The file history could not be loaded.');
      return;
    }
    const anchor = at ? this._history().findIndex((c) => c.sha === at) : 0;
    if (this._history().length === 0) {
      fail('unavailable', 'No commit history found for this file.');
      return;
    }
    if (anchor === -1) {
      fail('unavailable', 'This version is not part of the loaded history of the file.');
      return;
    }

    const v0 = await this.ensureFile(path, at);
    if (seq !== this.loadSeq) return;
    if (v0.status !== 'ready') {
      fail('error', v0.status === 'error' ? v0.message : 'The file content could not be loaded.');
      return;
    }
    if (v0.file.kind !== 'text') {
      fail('unavailable', 'Blame is only available for text files.');
      return;
    }

    const blamedLines = splitLines(v0.file.text);
    const owners: BlameOwner[] = new Array<BlameOwner>(blamedLines.length).fill(null);
    /** Position of each blamed line in the version currently examined; -1 = done. */
    const images = blamedLines.map((_, index) => index);
    let pending = blamedLines.length;
    let processed = 0;

    const publish = (status: 'computing' | 'ready', truncated: boolean): void =>
      this.setBlameState(key, { status, lines: [...owners], truncated, processed });

    publish('computing', false);
    let newerLines = blamedLines;

    for (let i = anchor; pending > 0; i++) {
      const newer = this._history()[i];
      const older = this._history()[i + 1];

      if (!older) {
        if (this._historyHasMore()) {
          // The trail continues past the loaded pages.
          for (let j = 0; j < owners.length; j++) if (owners[j] === null) owners[j] = 'older';
          publish('ready', true);
          return;
        }
        // Complete history: the oldest commit created the file.
        for (let j = 0; j < owners.length; j++) {
          if (owners[j] === null) owners[j] = { commit: newer, line: images[j] + 1 };
        }
        processed++;
        publish('ready', false);
        return;
      }

      // Soft-stop when the user switched files; partial state stays cached
      // and the walk resumes (cheaply) when the version is needed again.
      // Note: only the path is checked — the split changes view blames the
      // parent version while `viewAt` points at the commit itself.
      if (this._selectedPath() !== path) {
        publish('computing', false);
        return;
      }

      const olderState = await this.ensureFile(path, older.sha);
      if (seq !== this.loadSeq) return;
      if (olderState.status !== 'ready') {
        fail(
          'error',
          olderState.status === 'error'
            ? olderState.message
            : 'A previous version could not be loaded.',
        );
        return;
      }
      if (olderState.file.kind !== 'text') {
        // The file was binary before this point; everything left was
        // (re)introduced as text at `newer`.
        for (let j = 0; j < owners.length; j++) {
          if (owners[j] === null) owners[j] = { commit: newer, line: images[j] + 1 };
        }
        processed++;
        publish('ready', false);
        return;
      }

      const olderLines = splitLines(olderState.file.text);
      const ops = diffLines(olderLines, newerLines);
      const newToOld = new Map<number, number>();
      const added = new Set<number>();
      for (const op of ops) {
        if (op.kind === 'equal') newToOld.set(op.newLine - 1, op.oldLine - 1);
        else if (op.kind === 'add') added.add(op.newLine - 1);
      }

      for (let j = 0; j < blamedLines.length; j++) {
        const position = images[j];
        if (position < 0) continue;
        if (added.has(position)) {
          owners[j] = { commit: newer, line: position + 1 };
          images[j] = -1;
          pending--;
        } else {
          images[j] = newToOld.get(position) ?? -1;
          if (images[j] === -1) {
            // Defensive: a non-added line must map; attribute here if not.
            owners[j] = { commit: newer, line: position + 1 };
            pending--;
          }
        }
      }

      newerLines = olderLines;
      processed++;
      publish('computing', false);
    }

    publish('ready', false);
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

    const cached = this.historyCache.get(path);
    if (cached) {
      this._historyPath.set(path);
      this._history.set(cached.commits);
      this._historyError.set(null);
      this._historyHasMore.set(cached.hasMore);
      this._historyStatus.set('ready');
      this.historyPage = cached.page;
      return;
    }

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
      const hasMore = commits.length === HISTORY_PAGE_SIZE;
      this._historyHasMore.set(hasMore);
      this._historyStatus.set('ready');
      this.historyCache.set(path, { commits, hasMore, page: 1 });
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
      const merged = [...this._history(), ...commits];
      this._history.set(merged);
      this.cacheCommits(commits);
      const hasMore = commits.length === HISTORY_PAGE_SIZE;
      this._historyHasMore.set(hasMore);
      this._historyStatus.set('ready');
      this.historyCache.set(path, { commits: merged, hasMore, page });
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

  /**
   * Filters the history panel to the commits that changed a line range:
   * starting at `anchorSha` (whose version the range refers to), the file's
   * history is walked pairwise with the minimal diff — `git log -L` in
   * spirit. A commit is kept when its step touched the tracked range; the
   * range is then remapped onto the older version and followed further.
   * The walk ends where the range was introduced, or pauses at the end of
   * the loaded history pages ({@link extendLineTrace} continues it).
   */
  async startLineTrace(path: string, anchorSha: string, range: LineRange): Promise<void> {
    if (!this._slug() || this._phase() !== 'ready') return;
    const active = this._lineTrace();
    if (
      active &&
      active.status !== 'error' &&
      active.path === path &&
      active.anchorSha === anchorSha &&
      active.range.start === range.start &&
      active.range.end === range.end
    ) {
      return;
    }

    const run = ++this.traceRun;
    this.traceResume = null;
    this.originRun++;
    this._traceOrigins.set(null);
    this._lineTrace.set({
      status: 'computing',
      path,
      anchorSha,
      range,
      commits: [],
      scanned: 0,
      truncated: false,
      origin: null,
    });
    const fail = (message: string): void =>
      this._lineTrace.set({ ...this._lineTrace()!, status: 'error', message });

    const seq = this.loadSeq;
    await this.loadHistory(path);
    if (seq !== this.loadSeq || run !== this.traceRun) return;
    if (this._historyPath() !== path || this._historyStatus() !== 'ready') {
      fail(this._historyError() ?? 'The file history could not be loaded.');
      return;
    }
    const anchor = this._history().findIndex((c) => c.sha === anchorSha);
    if (anchor === -1) {
      fail('This version is not part of the loaded history of the file.');
      return;
    }
    await this.walkLineTrace(run, path, anchor, range);
  }

  /** Continues a trace that paused at the end of the loaded history pages. */
  async extendLineTrace(): Promise<void> {
    const state = this._lineTrace();
    const resume = this.traceResume;
    if (!state || state.status !== 'ready' || !state.truncated || !resume) return;

    const run = ++this.traceRun;
    this._lineTrace.set({ ...state, status: 'computing', truncated: false });
    const seq = this.loadSeq;
    await this.loadMoreHistory();
    if (seq !== this.loadSeq || run !== this.traceRun || !this._lineTrace()) return;
    if (this._historyStatus() !== 'ready') {
      this._lineTrace.set({
        ...this._lineTrace()!,
        status: 'error',
        message: this._historyError() ?? 'More history could not be loaded.',
      });
      return;
    }
    await this.walkLineTrace(run, state.path, resume.index, resume.range);
  }

  /** Drops the per-hunk history filter and any walk still running. */
  clearLineTrace(): void {
    this.traceRun++;
    this.traceResume = null;
    this._lineTrace.set(null);
    this.originRun++;
    this._traceOrigins.set(null);
  }

  /**
   * The trace walk itself: examines pairs `(history[i], history[i+1])` from
   * `index` on, collecting touching commits and publishing after every step
   * so matches appear as they are found. One (cached) file request per step,
   * shared with blame and the diff views.
   */
  private async walkLineTrace(
    run: number,
    path: string,
    index: number,
    range: LineRange,
  ): Promise<void> {
    const seq = this.loadSeq;
    const live = (): boolean =>
      seq === this.loadSeq && run === this.traceRun && this._lineTrace() !== null;

    const state = this._lineTrace()!;
    const commits = [...state.commits];
    let scanned = state.scanned;
    const publish = (patch: Partial<LineTraceState>): void =>
      this._lineTrace.set({ ...this._lineTrace()!, commits: [...commits], scanned, ...patch });
    const finish = (origin: LineTraceState['origin']): void => {
      this.traceResume = null;
      publish({ status: 'ready', truncated: false, origin });
    };

    let newerLines: readonly string[] | null = null;
    let r = range;
    for (let i = index; ; i++) {
      const newer = this._history()[i];
      const older = this._history()[i + 1];

      if (!older) {
        if (this._historyHasMore()) {
          this.traceResume = { index: i, range: r };
          publish({ status: 'ready', truncated: true });
          return;
        }
        // Complete history: the oldest commit introduced the tracked lines.
        commits.push(newer);
        finish({ sha: newer.sha, range: r });
        return;
      }

      if (newerLines === null) {
        const newerFile = await this.ensureFile(path, newer.sha);
        if (!live()) return;
        if (newerFile.status !== 'ready') {
          publish({
            status: 'error',
            message:
              newerFile.status === 'error'
                ? newerFile.message
                : 'The file content could not be loaded.',
          });
          return;
        }
        if (newerFile.file.kind !== 'text') {
          publish({ status: 'error', message: 'Tracing is only available for text files.' });
          return;
        }
        newerLines = splitLines(newerFile.file.text);
      }

      const olderFile = await this.ensureFile(path, older.sha);
      if (!live()) return;
      if (olderFile.status !== 'ready') {
        publish({
          status: 'error',
          message:
            olderFile.status === 'error'
              ? olderFile.message
              : 'A previous version could not be loaded.',
        });
        return;
      }
      if (olderFile.file.kind !== 'text') {
        // The file was binary before this point; `newer` (re)introduced the
        // text lines, so the trail ends with it.
        commits.push(newer);
        scanned++;
        finish({ sha: newer.sha, range: r });
        return;
      }

      const olderLines = splitLines(olderFile.file.text);
      const regions = changeRegions(diffLines(olderLines, newerLines));
      if (regions.some((region) => regionTouchesRange(region, r))) commits.push(newer);
      scanned++;

      const mapped = mapRangeToParent(regions, r);
      if (!mapped) {
        // The whole range was introduced by `newer` — nothing older to follow.
        finish({ sha: newer.sha, range: r });
        return;
      }
      r = mapped;
      newerLines = olderLines;
      publish({ status: 'computing' });
    }
  }

  /**
   * Searches for where a finished trace's lines came from: the block the
   * introducing commit added is located inside other files *as they were
   * just before that commit* (its first parent), with a line-level local
   * alignment. `'commit'` scope compares only the files the introducing
   * commit touched — a moved block's source shrank or vanished right there,
   * so deleted files are prime suspects. `'snapshot'` scope widens to the
   * whole parent tree (same-extension files first, capped).
   */
  async searchTraceOrigins(scope: HunkOriginScope): Promise<void> {
    const slug = this._slug();
    const trace = this._lineTrace();
    if (!slug || this._phase() !== 'ready') return;
    if (!trace || trace.status !== 'ready' || !trace.origin) return;
    const origin = trace.origin;

    const run = ++this.originRun;
    const seq = this.loadSeq;
    const live = (): boolean => seq === this.loadSeq && run === this.originRun;
    const base: HunkOriginState = {
      status: 'searching',
      scope,
      candidates: [],
      scanned: 0,
      total: 0,
      capped: false,
    };
    this._traceOrigins.set(base);
    const fail = (status: 'unavailable' | 'error', message: string): void =>
      this._traceOrigins.set({ ...base, status, message });

    try {
      const commit = await this.resolveCommit(slug, origin.sha);
      if (!live()) return;
      const parentSha = commit.parentShas[0] ?? null;
      if (!parentSha) {
        fail(
          'unavailable',
          "These lines arrived with the repository's first commit — there is nothing earlier to search.",
        );
        return;
      }

      const blockState = await this.ensureFile(trace.path, origin.sha);
      if (!live()) return;
      if (blockState.status !== 'ready' || blockState.file.kind !== 'text') {
        fail('error', 'The traced lines could not be loaded.');
        return;
      }
      const block = splitLines(blockState.file.text).slice(
        origin.range.start - 1,
        origin.range.end,
      );
      if (block.length === 0) {
        fail('unavailable', 'The traced range is empty at its introducing commit.');
        return;
      }

      const changes = await this.registry.byId(slug.provider).getCommitFiles(slug, commit.sha);
      if (!live()) return;
      const deleted = new Set(
        changes.filter((c) => c.status === 'removed').map((change) => change.path),
      );

      let paths: string[];
      let capped: boolean;
      if (scope === 'commit') {
        // Renamed entries live under their previous path at the parent.
        const touched = changes
          .filter((c) => c.status !== 'added')
          .map((c) => (c.status === 'renamed' && c.previousPath ? c.previousPath : c.path))
          .filter((p) => p !== trace.path);
        const unique = [...new Set(touched)];
        capped = unique.length > ORIGIN_COMMIT_CAP;
        paths = unique.slice(0, ORIGIN_COMMIT_CAP);
      } else {
        const entries = await this.treeAt(slug, parentSha);
        if (!live()) return;
        const ext = extensionOf(trace.path);
        const all = entries
          .filter((entry) => entry.kind === 'file' && entry.path !== trace.path)
          .sort((a, b) => {
            const extDelta =
              Number(extensionOf(b.path) === ext) - Number(extensionOf(a.path) === ext);
            return extDelta !== 0 ? extDelta : a.path.localeCompare(b.path);
          })
          .map((entry) => entry.path);
        capped = all.length > ORIGIN_SNAPSHOT_CAP;
        paths = all.slice(0, ORIGIN_SNAPSHOT_CAP);
      }

      const candidates: HunkOriginCandidate[] = [];
      let scanned = 0;
      const publish = (status: 'searching' | 'ready'): void => {
        const top = [...candidates].sort((a, b) => b.score - a.score).slice(0, ORIGIN_RESULT_CAP);
        this._traceOrigins.set({
          status,
          scope,
          candidates: top,
          scanned,
          total: paths.length,
          capped,
        });
      };
      publish('searching');
      for (const path of paths) {
        const state = await this.ensureFile(path, parentSha);
        if (!live()) return;
        scanned++;
        if (state.status === 'ready' && state.file.kind === 'text') {
          const match = findBlockOrigin(block, splitLines(state.file.text));
          if (match) {
            candidates.push({
              path,
              line: match.line,
              score: match.score,
              deleted: deleted.has(path),
              parentSha,
            });
          }
        }
        publish('searching');
      }
      publish('ready');
    } catch (error) {
      if (!live()) return;
      fail('error', toRepoProviderError(error).message);
    }
  }

  /**
   * Searches for predecessor files where `path`'s recorded history ends:
   * the provider's own rename detection at the creating commit, files the
   * creating commit *deleted* (prime rename sources, content-compared one
   * by one), identical blobs in the parent commit's tree, and heuristically
   * similar files refined by actual content similarity (top three, one
   * request each). Content comparisons use the line-structured fuzzy score,
   * so a rename that also edited lines still ranks high. Requires the
   * complete history of the path to be loaded.
   */
  async loadRenameCandidates(path: string): Promise<void> {
    const existing = this._renames().get(path);
    if (existing && existing.status !== 'error') return;
    const slug = this._slug();
    if (!slug || this._phase() !== 'ready') return;
    if (
      this._historyPath() !== path ||
      this._historyStatus() !== 'ready' ||
      this._historyHasMore() ||
      this._history().length === 0
    ) {
      return;
    }
    const history = this._history();
    const endCommit = history[history.length - 1];
    const parentSha = endCommit.parentShas[0] ?? null;

    const seq = this.loadSeq;
    this.setRenameState(path, { status: 'loading' });
    try {
      if (!parentSha) {
        this.setRenameState(path, {
          status: 'unavailable',
          reason:
            "This file was created in the repository's first commit — there is nothing earlier.",
        });
        return;
      }
      const provider = this.registry.byId(slug.provider);

      // 1. Provider-side rename detection at the creating commit.
      const changes = await provider.getCommitFiles(slug, endCommit.sha);
      if (seq !== this.loadSeq) return;
      const renamedFrom =
        changes.find((c) => c.path === path && c.previousPath)?.previousPath ?? null;

      // 2. The file's own content at its creation, for sha/content matching.
      const v0 = await this.ensureFile(path, endCommit.sha);
      if (seq !== this.loadSeq) return;
      const v0Sha = v0.status === 'ready' ? v0.file.sha : null;
      const v0Size = v0.status === 'ready' ? v0.file.size : null;
      const v0Text = v0.status === 'ready' && v0.file.kind === 'text' ? v0.file.text : null;

      // 3. Everything that existed just before the path appeared.
      const parentEntries = await this.treeAt(slug, parentSha);
      if (seq !== this.loadSeq) return;
      const files = parentEntries.filter((e) => e.kind === 'file' && e.path !== path);

      const byPath = new Map<string, RenameCandidate>();
      const add = (candidate: RenameCandidate): void => {
        const prior = byPath.get(candidate.path);
        if (!prior) {
          byPath.set(candidate.path, candidate);
          return;
        }
        byPath.set(candidate.path, {
          ...prior,
          confidence: Math.max(prior.confidence, candidate.confidence),
          reasons: [...new Set([...prior.reasons, ...candidate.reasons])],
        });
      };

      if (renamedFrom) {
        const entry = files.find((e) => e.path === renamedFrom);
        add({
          path: renamedFrom,
          sha: entry?.sha ?? '',
          ...(entry?.size !== undefined ? { size: entry.size } : {}),
          confidence: 0.99,
          reasons: ['github-rename'],
        });
      }
      if (v0Sha) {
        for (const entry of files) {
          if (entry.sha === v0Sha) {
            add({
              path: entry.path,
              sha: entry.sha,
              ...(entry.size !== undefined ? { size: entry.size } : {}),
              confidence: 1,
              reasons: ['identical-content'],
            });
          }
        }
      }

      // 3.5 Files the creating commit deleted: when a rename happens without
      // the provider noticing, the old path disappears in this very commit —
      // compare each deleted file's content directly.
      const deletedPaths = changes
        .filter((c) => c.status === 'removed' && c.path !== path)
        .map((c) => c.path)
        .slice(0, RENAME_DELETED_CAP);
      for (const deletedPath of deletedPaths) {
        const entry = files.find((e) => e.path === deletedPath);
        let similarity = 0;
        if (v0Text !== null) {
          const deletedState = await this.ensureFile(deletedPath, parentSha);
          if (seq !== this.loadSeq) return;
          if (deletedState.status === 'ready' && deletedState.file.kind === 'text') {
            similarity = fuzzyLineSimilarity(deletedState.file.text, v0Text);
          }
        }
        const reasons: ('deleted-in-commit' | 'similar-content')[] =
          similarity >= 0.5 ? ['deleted-in-commit', 'similar-content'] : ['deleted-in-commit'];
        add({
          path: deletedPath,
          sha: entry?.sha ?? '',
          ...(entry?.size !== undefined ? { size: entry.size } : {}),
          confidence: Math.min(0.98, 0.15 + similarity * 0.85),
          reasons,
        });
      }

      // 4. Heuristic candidates, refined by content similarity for the top few.
      const name = path.slice(path.lastIndexOf('/') + 1);
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
      const dirSegments = path.split('/').slice(0, -1);
      const scored = files
        .filter((e) => !byPath.has(e.path))
        .map((entry) => {
          const entryExt = entry.name.includes('.')
            ? entry.name.slice(entry.name.lastIndexOf('.'))
            : '';
          let score = 0;
          if (entry.name === name) score += 0.45;
          else if (ext && entryExt === ext) score += 0.1;
          if (v0Size !== null && entry.size !== undefined) {
            const max = Math.max(v0Size, entry.size, 1);
            score += 0.2 * (1 - Math.abs(v0Size - entry.size) / max);
          }
          const entrySegments = entry.path.split('/').slice(0, -1);
          const shared = sharedPrefixLength(dirSegments, entrySegments);
          const maxSegments = Math.max(dirSegments.length, entrySegments.length);
          score += 0.25 * (maxSegments === 0 ? 1 : shared / maxSegments);
          return { entry, score };
        })
        .filter((c) => c.score >= 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      for (const [index, { entry, score }] of scored.entries()) {
        let confidence = Math.min(score, 0.75);
        const reasons: ('similar-content' | 'heuristic')[] = ['heuristic'];
        if (index < 3 && v0Text !== null) {
          const candidateState = await this.ensureFile(entry.path, parentSha);
          if (seq !== this.loadSeq) return;
          if (candidateState.status === 'ready' && candidateState.file.kind === 'text') {
            const similarity = fuzzyLineSimilarity(candidateState.file.text, v0Text);
            confidence = Math.max(confidence, similarity);
            if (similarity >= 0.5) reasons.unshift('similar-content');
          }
        }
        add({
          path: entry.path,
          sha: entry.sha,
          ...(entry.size !== undefined ? { size: entry.size } : {}),
          confidence,
          reasons,
        });
      }

      const candidates = [...byPath.values()]
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 8);
      this.setRenameState(path, { status: 'ready', candidates, parentSha, endCommit });
    } catch (error) {
      if (seq !== this.loadSeq) return;
      this.setRenameState(path, {
        status: 'error',
        message: toRepoProviderError(error).message,
      });
    }
  }

  /**
   * The most recent commit reachable from `ref` that touched `path` — used
   * to anchor the jump into a rename candidate's own timeline.
   */
  async lastTouch(path: string, ref: string): Promise<CommitInfo | null> {
    const slug = this._slug();
    if (!slug) return null;
    try {
      const commits = await this.registry
        .byId(slug.provider)
        .listCommits(slug, { ref, path, perPage: 1 });
      if (commits.length === 0) return null;
      this.cacheCommits(commits);
      return commits[0];
    } catch {
      return null;
    }
  }

  /** Full tree entries at a commit, cached per sha (shared across searches). */
  private treeAt(slug: RepoSlug, sha: string): Promise<readonly TreeEntry[]> {
    const cached = this.treeCache.get(sha);
    if (cached) return cached;
    const promise = this.registry
      .byId(slug.provider)
      .getTree(slug, sha)
      .then((tree) => tree.entries);
    this.treeCache.set(sha, promise);
    promise.catch(() => this.treeCache.delete(sha));
    return promise;
  }

  clearSelection(): void {
    this._selectedPath.set(null);
    this._viewAt.set(null);
    this.clearLineTrace();
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
    // Some providers (Azure DevOps) omit parents in commit lists; an entry
    // without parents could be a root commit or just unfilled — fetch the
    // full commit once to disambiguate.
    if (cached && cached.parentShas.length > 0) return cached;
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

  private setBlameState(key: string, state: BlameState): void {
    const next = new Map(this._blames());
    next.set(key, state);
    this._blames.set(next);
  }

  private setRenameState(path: string, state: RenameState): void {
    const next = new Map(this._renames());
    next.set(path, state);
    this._renames.set(next);
  }
}

function sharedPrefixLength(a: readonly string[], b: readonly string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** File extension including the dot, or '' when there is none. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

/**
 * Cache key for file content and diffs. The prefix is either `tip` or a
 * commit sha, so paths (which can contain anything) cannot collide across
 * refs.
 */
function fileKey(path: string, at: string | null): string {
  return `${at ?? 'tip'}::${path}`;
}
