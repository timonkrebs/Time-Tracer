import { Injectable, computed, inject, signal } from '@angular/core';

import { ProviderRegistry, RepoWebLinks } from '../git/git-provider';
import { normalizeInstanceHost } from '../git/host-url';
import { AnalysisRunner } from './analysis-runner';
import {
  CommitFileChange,
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
import { CoChangeResult, CommitFiles, RelatedFile, relatedFiles } from '../util/co-change';
import { FileDiff, computeFileDiff, diffLines, lineSimilarity, splitLines } from '../util/diff';
import { FileMetric, Hotspot, computeFileMetric } from '../util/hotspots';
import { isGeneratedFile } from '../util/ignore';
import { KnowledgeModel } from '../util/knowledge';
import { TeamGraph } from '../util/team-graph';
import { AggregateInput, AggregateResult, aggregateInsights } from '../util/analysis';
import { Forecast } from '../util/forecast';
import {
  LineRange,
  changeRegions,
  followRange,
  movedLinePairs,
  regionTouchesRange,
} from '../util/line-range';
import { findBlockOrigin, fuzzyLineSimilarity } from '../util/similarity';
import {
  FileRisk,
  OwnershipSummary,
  computeOwnershipRisk,
  selectOwnershipFiles,
  summarizeOwnership,
} from '../util/ownership';
import { applyPatch, parsePatch, patchStatsMatch } from '../util/patch';
import {
  CohortBucket,
  LineLifetime,
  SurvivalReport,
  cohortStackFor,
  summarizeSurvival,
} from '../util/survival';
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
/** Files blamed for a per-folder ownership summary (it is request-heavy). */
export const FOLDER_OWNERSHIP_CAP = 30;
/** Files blamed concurrently for the folder ownership scan (each blame is independent). */
const FOLDER_OWNERSHIP_CONCURRENCY = 6;

/** Recent commits walked for the co-change analysis (one request per commit). */
export const CO_CHANGE_COMMIT_CAP = 75;
/** Per-commit changed-file fetches kept in flight at once during the co-change walk. */
const CO_CHANGE_PREFETCH = 12;

/** Safety cap for a single file's full-history co-change walk. */
export const FILE_COCHANGE_COMMIT_CAP = 400;

/** Shared empty size map for the knowledge model on a single-file focus walk. */
const EMPTY_SIZES: ReadonlyMap<string, number> = new Map();
/** The empty aggregation used for the synchronous first 'computing' frame. */
const EMPTY_AGGREGATE: AggregateResult = aggregateInsights({
  commits: [],
  sizes: EMPTY_SIZES,
  partial: true,
});
/** Commit file-lists kept in flight at once during the survival walk (overlaps the requests). */
const SURVIVAL_PREFETCH = 12;
/** Minimum gap between streaming recomputes of the survival report (it is O(lines)). */
const SURVIVAL_PUBLISH_MS = 600;
/** Cap on removed×added pairs the survival walk will similarity-test for renames per commit. */
const SURVIVAL_RENAME_PAIR_LIMIT = 200;
/** Minimum content similarity (0..1) to treat an unflagged remove+add as a rename. */
const SURVIVAL_RENAME_SIMILARITY = 0.5;

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
      /** Path that supplied the old side; null when the old side is empty. */
      readonly basePath: string | null;
      /** Path that supplied the new side; null when the commit deleted it. */
      readonly headPath: string | null;
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

/** One commit surfaced by an active line trace, with the range it changed. */
export interface LineTraceHit {
  readonly commit: CommitInfo;
  readonly path: string;
  /** New-side coordinates in {@link commit}'s version. */
  readonly range: LineRange;
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
  /** Commit/range pairs for navigation and line highlighting. */
  readonly hits: readonly LineTraceHit[];
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
  /**
   * 0..1 — how much of this whole file matches the traced file (shared lines
   * over the larger line count). Tells a coincidental block hit in an
   * unrelated file from a file the traced one was actually split out of.
   */
  readonly fileSimilarity: number;
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

/**
 * Async state of the per-folder ownership scan: blame is computed for the
 * folder's files (up to {@link FOLDER_OWNERSHIP_CAP}) and their attribution
 * aggregated into one summary, streaming as each file is added.
 */
export interface FolderOwnershipState {
  readonly status: 'computing' | 'ready' | 'error';
  /** Folder path scanned; '' for the repository root. */
  readonly path: string;
  /** Aggregated authorship of the files scanned so far. */
  readonly summary: OwnershipSummary;
  /** Files scanned so far, ranked by knowledge-loss risk (orphaned lines). */
  readonly riskFiles?: readonly FileRisk[];
  /** Files to scan (after the cap) and how many are done. */
  readonly filesTotal: number;
  readonly filesScanned: number;
  /** Files under the folder before any cap (what "scan all" would cover). */
  readonly matchedTotal: number;
  /** True when the folder held more files than the cap. */
  readonly capped: boolean;
  /** Paths included in this scan, for the "files scanned" tooltip. */
  readonly files: readonly string[];
  /**
   * True when folded from blame already in cache rather than an explicit scan
   * — the chart is then "free" data the panel shows without an opt-in, and
   * there is nothing to clear.
   */
  readonly fromCache?: boolean;
  readonly message?: string;
}

/**
 * Async state of the co-change analysis: recent commits are walked (one
 * request per commit for its file list), and their file-sets folded into
 * temporal coupling, published as it streams in.
 */
export interface CoChangeState {
  readonly status: 'computing' | 'ready' | 'error';
  /** The file the analysis is focused on (its full history), or undefined for repo-wide. */
  readonly focus?: string;
  /** Commits whose files have been fetched so far. */
  readonly scanned: number;
  /** Commit cap the walk is working toward. */
  readonly target: number;
  /** Coupling aggregated from the commits scanned so far. */
  readonly result: CoChangeResult;
  /** Files ranked by recency-weighted churn (repo-wide only; empty for a focus). */
  readonly hotspots: readonly Hotspot[];
  /**
   * Developer collaboration graph from the same walk — who works with whom, by
   * shared file authorship (repo-wide only; the empty graph for a focus).
   */
  readonly teamGraph: TeamGraph;
  /** Knowledge-loss / turnover risk per file (repo-wide only; empty for a focus). */
  readonly knowledge: KnowledgeModel;
  /** Files whose churn is accelerating — likely next hotspots (repo-wide only). */
  readonly forecast?: Forecast;
  /** Author timestamps (ISO) of the walked commits — drives the punch card. */
  readonly commitTimes?: readonly string[];
  /** Distinct generated/vendored files held out of the metrics, if any. */
  readonly excludedFiles?: number;
  readonly message?: string;
}

/**
 * Async state of the code-survival analysis: the whole history is walked
 * forward (oldest → newest), every commit's changed files diffed against the
 * running snapshot so each line's birth and death is recorded, and the cohort
 * stack / authorship share / Kaplan–Meier curve folded from those lifetimes.
 * Because a snapshot of survivors alone can't reveal deaths, this needs the
 * full walk — request-heavy on hosted providers, cheap on local repositories.
 */
export interface SurvivalState {
  readonly status: 'reading' | 'computing' | 'ready' | 'error';
  /** Commits walked so far. */
  readonly scanned: number;
  /** Commits to walk (0 until the history has been counted). */
  readonly total: number;
  /** Everything the Age tab renders, recomputed as the walk streams. */
  readonly report: SurvivalReport;
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
  private readonly analysis = inject(AnalysisRunner);

  private loadSeq = 0;
  /**
   * A self-hosted instance host that failed validation and was stripped from the
   * stored slug, kept so {@link retry} can re-submit (and re-reject) it instead
   * of silently loading the public repository for the same owner/repo.
   */
  private rejectedHost: string | null = null;
  /**
   * The requested ref of the tree currently in {@link _entries} (the last load
   * that reached `ready`). When a reload of the same repository fails and the
   * user explores anyway, the ref is restored to this so the kept tree, the ref
   * label, and history/links all refer to the same revision.
   */
  private lastLoadedRef: string | null = null;
  /** In-flight file fetches keyed like {@link fileKey}, to dedupe callers. */
  private readonly inflight = new Map<string, Promise<FileState>>();

  private readonly _phase = signal<RepoLoadPhase>('idle');
  private readonly _error = signal<RepoProviderError | null>(null);
  private readonly _slug = signal<RepoSlug | null>(null);
  private readonly _requestedRef = signal<string | null>(null);
  private readonly _metadata = signal<RepoMetadata | null>(null);
  private readonly _entries = signal<readonly TreeEntry[]>([]);
  private readonly _truncated = signal(false);
  /**
   * True when the user chose to explore a repository whose load did not finish
   * (the provider blocked further API access), so what's shown is whatever was
   * already loaded — see {@link exploreAnyway}.
   */
  private readonly _incomplete = signal(false);
  private readonly _selectedPath = signal<string | null>(null);
  /** Commit sha the selected file is viewed at; null = the loaded snapshot. */
  private readonly _viewAt = signal<string | null>(null);
  /** File contents keyed by `<sha|tip>::<path>` (see {@link fileKey}). */
  private readonly _files = signal<ReadonlyMap<string, FileState>>(new Map());
  private readonly _expanded = signal<ReadonlySet<string>>(new Set());
  /** Every commit seen so far (history pages, single lookups), by sha. */
  private readonly _commitsBySha = signal<ReadonlyMap<string, CommitInfo>>(new Map());
  /** Diff states keyed by {@link diffStateKey} (`<sha>::<path>`, plus base). */
  private readonly _diffs = signal<ReadonlyMap<string, DiffState>>(new Map());
  /** Predecessor path the changes view diffs against, or null for the commit's own changes. */
  private readonly _compareBase = signal<string | null>(null);
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
  /**
   * Recency-weighted change metrics keyed by path, for every file whose
   * history has been loaded — the data behind hotspot badges in the file tree.
   */
  private readonly _fileMetrics = signal<ReadonlyMap<string, FileMetric>>(new Map());

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
  /** Per-folder ownership scan, when started. */
  private readonly _folderOwnership = signal<FolderOwnershipState | null>(null);
  /** Bumped to cancel a superseded or cleared folder scan. */
  private folderRun = 0;
  /** Repo-wide co-change analysis (hotspots + coupling), when started. */
  private readonly _coChange = signal<CoChangeState | null>(null);
  /** Bumped to cancel a superseded or cleared repo-wide walk. */
  private coChangeRun = 0;
  /** The active "filter coupling by file" — that file's full-history coupling. */
  private readonly _coupleFocus = signal<CoChangeState | null>(null);
  /** Bumped to cancel a superseded or cleared focus walk. */
  private focusRun = 0;
  /** Changed files (with line stats) per commit sha, shared by the co-change walks. */
  private readonly commitFilesCache = new Map<string, Promise<readonly CommitFileChange[]>>();
  /** Repo-wide code-survival analysis (cohorts + Kaplan–Meier), when started. */
  private readonly _survival = signal<SurvivalState | null>(null);
  /** Cohort-stack granularity for the Age tab (week / month / year). */
  private readonly _cohortBucket = signal<CohortBucket>('year');
  /**
   * The finished walk's lifetimes + tip time, retained so the cohort granularity
   * can be changed without re-walking history — only the cohort stack is rebuilt
   * (O(lines)). Null until a survival run completes (or while one is in flight).
   */
  private survivalLifetimes: readonly LineLifetime[] | null = null;
  private survivalNow = 0;
  /** Bumped to cancel a superseded or cleared survival walk. */
  private survivalRun = 0;

  readonly phase = this._phase.asReadonly();
  readonly error = this._error.asReadonly();
  readonly slug = this._slug.asReadonly();
  readonly metadata = this._metadata.asReadonly();
  readonly truncated = this._truncated.asReadonly();
  /** True while showing a repository whose load was cut short (see {@link exploreAnyway}). */
  readonly incomplete = this._incomplete.asReadonly();
  /**
   * Whether a failed load left enough behind to explore anyway — a tree from a
   * previous successful load of the same repository survives a failed reload, so
   * the error screen can offer to drop into it instead of dead-ending.
   */
  readonly canExplorePartial = computed(
    () => this._phase() === 'error' && this._entries().length > 0,
  );
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
  readonly folderOwnership = this._folderOwnership.asReadonly();
  readonly coChange = this._coChange.asReadonly();
  readonly coupleFocus = this._coupleFocus.asReadonly();
  readonly survival = this._survival.asReadonly();
  /** Cohort-stack granularity for the Age tab (week / month / year). */
  readonly cohortBucket = this._cohortBucket.asReadonly();
  readonly fileMetrics = this._fileMetrics.asReadonly();

  /** Files coupled to the selected one (empty until co-change has been run). */
  readonly selectedRelated = computed<RelatedFile[]>(() => {
    const state = this._coupleFocus() ?? this._coChange();
    const path = this._selectedPath();
    if (!state || !path) return [];
    return relatedFiles(state.result, path);
  });

  /** Ref shown in the viewer: the requested one, or the default branch. */
  readonly ref = computed(() => this._requestedRef() ?? this._metadata()?.defaultBranch ?? null);

  /**
   * True when the active provider reads the whole repository from a local
   * object database (the local folder reader) rather than a paged remote API.
   * Bulk passes like the folder-ownership scan then cost no network requests,
   * so callers can run them eagerly instead of behind an opt-in. Detected via
   * the optional {@link GitProvider.primeHistories} capability, which only such
   * providers implement.
   */
  readonly hasLocalData = computed(() => {
    const slug = this._slug();
    return slug != null && this.registry.byId(slug.provider).primeHistories != null;
  });

  readonly tree = computed(() => buildTree(this._entries()));

  readonly fileCount = computed(() => this._entries().filter((e) => e.kind === 'file').length);
  readonly dirCount = computed(() => this._entries().filter((e) => e.kind === 'dir').length);

  /** Flat, path-sorted list of file entries — the corpus the file finder ranks. */
  readonly files = computed(() =>
    this._entries()
      .filter((e) => e.kind === 'file')
      .sort((a, b) => a.path.localeCompare(b.path)),
  );

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
    return this._diffs().get(diffStateKey(path, at, this._compareBase())) ?? null;
  });

  /** Blame of the selected file at the current view ref, if requested. */
  readonly selectedBlame = computed<BlameState | null>(() => {
    const path = this._selectedPath();
    if (!path) return null;
    return this._blames().get(fileKey(path, this._viewAt())) ?? null;
  });

  /**
   * Authorship of the selected file, folded from its blame — free, reactive,
   * and streaming as blame fills in. Null until blame has begun computing.
   */
  readonly selectedOwnership = computed<OwnershipSummary | null>(() => {
    const blame = this.selectedBlame();
    if (!blame || (blame.status !== 'ready' && blame.status !== 'computing')) return null;
    return summarizeOwnership(blame.lines);
  });

  /**
   * Knowledge-loss risk of the selected file, folded from its blame: how many of
   * its lines are owned by contributors who have gone quiet. Null until blame
   * has begun. (Departure is judged from this file's own history; a folder scan
   * widens that view across its files.)
   */
  readonly selectedFileRisk = computed<FileRisk | null>(() => {
    const path = this._selectedPath();
    const blame = this.selectedBlame();
    if (!path || !blame || (blame.status !== 'ready' && blame.status !== 'computing')) return null;
    return computeOwnershipRisk([{ path, lines: blame.lines }])[0] ?? null;
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

  /** Recency-weighted change metric for the selected file, once loaded. */
  readonly selectedFileMetric = computed<FileMetric | null>(() => {
    const path = this._selectedPath();
    return path ? (this._fileMetrics().get(path) ?? null) : null;
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

    // The instance host arrives from a user-controlled query param and survives
    // in shareable deep links, so it is validated here — the one gate every load
    // passes through — before it can reach a fetch() or be rendered into a link.
    // Only plain http(s) origins are allowed; a javascript:/data:/file: URL is
    // dropped and surfaced as a load error instead of silently hitting the
    // wrong (public) host.
    let invalidHost = false;
    if (slug.host !== undefined) {
      const safeHost = normalizeInstanceHost(slug.host);
      if (safeHost) {
        slug = { ...slug, host: safeHost };
        this.rejectedHost = null;
      } else {
        this.rejectedHost = slug.host;
        slug = { provider: slug.provider, owner: slug.owner, repo: slug.repo };
        invalidHost = true;
      }
    } else {
      this.rejectedHost = null;
    }

    if (
      !invalidHost &&
      !options?.force &&
      this.isCurrentTarget(slug, ref) &&
      this._phase() !== 'error'
    ) {
      return;
    }

    const seq = ++this.loadSeq;
    const sameRepo = this.isSameRepo(this._slug(), slug);
    this._slug.set(slug);
    this._requestedRef.set(ref);
    // Switching to a different repository clears its predecessor's tree/metadata
    // up front. Reloading the *same* repository (a ref change or retry) keeps the
    // already-loaded tree in place, so if this load fails the user can still fall
    // back to exploring what was loaded (see exploreAnyway) instead of losing it.
    if (!sameRepo) {
      this._metadata.set(null);
      this._entries.set([]);
      this._truncated.set(false);
      this.treeCache.clear();
    }
    this._incomplete.set(false);
    this._selectedPath.set(null);
    this._viewAt.set(null);
    this._files.set(new Map());
    this._expanded.set(new Set());
    this._commitsBySha.set(new Map());
    this._diffs.set(new Map());
    this._compareBase.set(null);
    this._blames.set(new Map());
    this._renames.set(new Map());
    this._fileMetrics.set(new Map());
    this.blameRuns.clear();
    this.historyCache.clear();
    this.commitFilesCache.clear();
    this.inflight.clear();
    this._error.set(null);
    this.resetHistory();
    this.clearLineTrace();
    this.clearFolderOwnership();
    this.clearCoChange();
    this.clearSurvival();
    this._phase.set('metadata');

    try {
      if (invalidHost) {
        throw new RepoProviderError(
          'That self-hosted instance URL is not a valid http(s) address.',
          'unknown',
        );
      }
      const provider = this.registry.byId(slug.provider);
      const metadata = await provider.getMetadata(slug);
      if (seq !== this.loadSeq) return;
      this._metadata.set(metadata);
      this._phase.set('tree');

      const tree = await provider.getTree(slug, ref ?? metadata.defaultBranch);
      if (seq !== this.loadSeq) return;
      this._entries.set(tree.entries);
      this._truncated.set(tree.truncated);
      this.lastLoadedRef = ref;
      this._phase.set('ready');

      this.recents.record({
        owner: metadata.owner,
        repo: metadata.name,
        description: metadata.description,
        provider: slug.provider,
        ...(slug.host ? { host: slug.host } : {}),
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
    // A rejected self-hosted host was stripped from the stored slug; restore it
    // so the retry re-validates (and re-rejects) it rather than silently loading
    // the public repository for the same owner/repo.
    const host = this.rejectedHost;
    void this.loadRepo(host ? { ...slug, host } : slug, this._requestedRef() ?? undefined, {
      force: true,
    });
  }

  /**
   * Dismisses a load error and drops into whatever was already loaded — used when
   * the provider blocked further API access mid-load but a previous load of the
   * same repository left a usable tree behind. Marks the repository
   * {@link incomplete} so the viewer can warn that it isn't fully loaded; the
   * original error message is kept for that warning. A no-op when there is
   * nothing to explore.
   */
  exploreAnyway(): void {
    if (this._phase() !== 'error' || this._entries().length === 0) return;
    // The kept tree belongs to the last load that succeeded; restore its ref so
    // the ref label, file links and history all match what's actually shown
    // (the failed reload may have been for a different ref).
    this._requestedRef.set(this.lastLoadedRef);
    this._incomplete.set(true);
    this._phase.set('ready');
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
   * Sets (or clears with null) the predecessor path the changes view diffs
   * against, instead of the commit's own first-parent diff. Driven by the
   * `base` query param; the diff itself is computed by {@link loadDiff}.
   */
  setCompareBase(base: string | null): void {
    this._compareBase.set(base);
  }

  /**
   * Computes what the commit `at` changed in `path`: the file at the commit
   * diffed against its first parent. A file the commit renamed *away* keeps
   * its new path on the head side; a file the commit *introduced* (absent at
   * the parent under this path) is shown as added rather than diffed against
   * the file it was renamed from — that predecessor is reached through the
   * history panel's "Continue past the rename?" step, so the oldest commit of
   * a path's recorded history reads as the file's creation. Pass `base` to
   * diff against a chosen predecessor instead: that path at the parent becomes
   * the old side (used by "Diff" on a rename candidate). Cached per
   * `<commit, path, base>`; reuses file-content caches.
   */
  async loadDiff(path: string, at: string, base: string | null = null): Promise<void> {
    const key = diffStateKey(path, at, base);
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

      const provider = this.registry.byId(slug.provider);
      let changes: readonly CommitFileChange[] | null = null;
      const commitFiles = async (): Promise<readonly CommitFileChange[]> => {
        changes ??= await provider.getCommitFiles(slug, at);
        return changes;
      };

      // The base side defaults to this same path at the parent; `base`
      // overrides it to diff against a chosen predecessor candidate there.
      const baseFetchPath = base ?? path;
      let currentState: FileState | null;
      let baseState: FileState | null;
      [currentState, baseState] = await Promise.all([
        this.ensureFile(path, at),
        baseSha ? this.ensureFile(baseFetchPath, baseSha) : Promise.resolve(null),
      ]);
      if (seq !== this.loadSeq) return;

      let headPath: string | null = currentState.status === 'ready' ? path : null;
      if (baseSha && currentState.status === 'error' && currentState.kind === 'not-found') {
        const movedTo = (await commitFiles()).find((c) => c.previousPath === path);
        if (seq !== this.loadSeq) return;
        if (movedTo) {
          currentState = await this.ensureFile(movedTo.path, at);
          if (seq !== this.loadSeq) return;
          headPath = currentState.status === 'ready' ? movedTo.path : null;
        } else {
          const removed = changes!.some((c) => c.path === path && c.status === 'removed');
          if (removed) currentState = null;
        }
      }

      let currentText = '';
      if (currentState) {
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
        currentText = currentState.file.text;
      } else {
        headPath = null;
      }

      // With no `base`, a file absent at the parent under this path was
      // introduced by this commit and is shown as added (issue #8) — never
      // auto-diffed against the file it was renamed from; the history panel's
      // "Continue past the rename?" step explores that predecessor instead.
      const basePath: string | null = baseState?.status === 'ready' ? baseFetchPath : null;

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

      const diff = computeFileDiff(baseText, currentText);
      this.setDiffState(key, { status: 'ready', diff, commit, baseSha, basePath, headPath });
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
      // Re-walk until the blame has consumed all loaded history. More pages can
      // arrive while we compute (e.g. "Load all" paging in parallel); a
      // truncated result should pick them up instead of staying stale.
      for (;;) {
        const before = this.historyCache.get(path)?.commits.length ?? 0;
        await this.runBlame(key, path, atRef);
        const state = this._blames().get(key);
        if (!state || state.status !== 'ready' || !state.truncated) break;
        const after = this.historyCache.get(path)?.commits.length ?? 0;
        if (after <= before) break;
      }
    } finally {
      this.blameRuns.delete(key);
    }
  }

  private canExtendBlame(path: string, at: string | null, state: BlameState): boolean {
    const cached = this.historyCache.get(path);
    if (!cached) return false;
    const history = cached.commits;
    const anchor = at ? history.findIndex((c) => c.sha === at) : 0;
    if (anchor === -1) return false;
    return history.length - anchor > state.processed;
  }

  private async runBlame(key: string, path: string, at: string | null): Promise<void> {
    const seq = this.loadSeq;
    const fail = (status: 'unavailable' | 'error', message: string): void =>
      this.setBlameState(key, { status, lines: [], truncated: false, processed: 0, message });

    if (this._selectedPath() === path) await this.loadHistory(path);
    const historyState = await this.historyFor(path);
    if (seq !== this.loadSeq) return;
    if (!historyState) {
      fail('error', 'The file history could not be loaded.');
      return;
    }
    const history = historyState.commits;
    const anchor = at ? history.findIndex((c) => c.sha === at) : 0;
    if (history.length === 0) {
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
      const newer = history[i];
      const older = history[i + 1];

      if (!older) {
        if (historyState.hasMore) {
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

      const olderState = await this.ensureFile(path, older.sha);
      if (seq !== this.loadSeq) return;
      if (olderState.status === 'error' && olderState.kind === 'not-found') {
        // The file is absent at `older` — it was deleted there and re-added
        // since (`older` is in the path's history because that deletion touched
        // it). So `newer` (re)introduced everything still pending; attribute it
        // and stop, exactly like reaching the file's creation, instead of
        // failing the whole blame with a "does not exist" error.
        for (let j = 0; j < owners.length; j++) {
          if (owners[j] === null) owners[j] = { commit: newer, line: images[j] + 1 };
        }
        processed++;
        publish('ready', false);
        return;
      }
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
      const moved = movedLinePairs(ops);
      const newToOld = new Map<number, number>();
      const added = new Set<number>();
      for (const op of ops) {
        if (op.kind === 'equal') newToOld.set(op.newLine - 1, op.oldLine - 1);
        else if (op.kind === 'add') {
          const oldLine = moved.get(op.newLine);
          if (oldLine !== undefined) newToOld.set(op.newLine - 1, oldLine - 1);
          else added.add(op.newLine - 1);
        }
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
      this.recordMetric(path, cached.commits, cached.hasMore);
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
      this.recordMetric(path, commits, hasMore);
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
      this.recordMetric(path, merged, hasMore);
    } catch (error) {
      if (seq !== this.loadSeq || this._historyPath() !== path) return;
      // Keep the already-loaded commits; just surface the failure.
      this._historyError.set(toRepoProviderError(error).message);
      this._historyStatus.set('error');
    }
  }

  /**
   * Pages in every remaining commit of the current file's history in one go.
   * The merged history is published once at the end, so dependents (blame, the
   * steppers, rename search) recompute against the complete list a single time
   * rather than once per page.
   */
  async loadAllHistory(): Promise<void> {
    const slug = this._slug();
    const path = this._historyPath();
    if (!slug || !path || this._historyStatus() !== 'ready' || !this._historyHasMore()) return;

    const seq = this.loadSeq;
    const provider = this.registry.byId(slug.provider);
    this._historyStatus.set('loading-more');
    try {
      const merged = [...this._history()];
      const fetched: CommitInfo[] = [];
      let page = this.historyPage;
      let hasMore = true;
      while (hasMore) {
        page++;
        const commits = await provider.listCommits(slug, {
          ref: this.ref() ?? undefined,
          path,
          perPage: HISTORY_PAGE_SIZE,
          page,
        });
        if (seq !== this.loadSeq || this._historyPath() !== path) return;
        merged.push(...commits);
        fetched.push(...commits);
        hasMore = commits.length === HISTORY_PAGE_SIZE;
      }
      this.historyPage = page;
      // Cache only the newly fetched pages, not the already-known commits.
      this.cacheCommits(fetched);
      this._history.set(merged);
      this._historyHasMore.set(false);
      this._historyStatus.set('ready');
      this.historyCache.set(path, { commits: merged, hasMore: false, page });
      this.recordMetric(path, merged, false);
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

  private async historyFor(
    path: string,
  ): Promise<{ commits: readonly CommitInfo[]; hasMore: boolean; page: number } | null> {
    const cached = this.historyCache.get(path);
    if (cached) return cached;
    const slug = this._slug();
    if (!slug || this._phase() !== 'ready') return null;
    try {
      const commits = await this.registry.byId(slug.provider).listCommits(slug, {
        ref: this.ref() ?? undefined,
        path,
        perPage: HISTORY_PAGE_SIZE,
      });
      this.cacheCommits(commits);
      const entry = { commits, hasMore: commits.length === HISTORY_PAGE_SIZE, page: 1 };
      this.historyCache.set(path, entry);
      this.recordMetric(path, commits, entry.hasMore);
      return entry;
    } catch {
      return null;
    }
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
      hits: [],
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

  /** Drops any per-folder ownership result and cancels a scan in progress. */
  clearFolderOwnership(): void {
    this.folderRun++;
    this._folderOwnership.set(null);
  }

  /**
   * Folds a folder ownership summary from blame **already in cache** — no
   * history walk, no requests. Returns a ready result only when every file the
   * scan would cover (the capped, largest-first selection under `folderPath`)
   * is already blamed, so the "Folder · …" chart can be shown for free instead
   * of the opt-in "Scan this folder" prompt — for networked providers too.
   * Returns null while any of those files is still unblamed, so the prompt
   * stays until a scan (or enough browsing) has produced the data. Pure read of
   * the entry/blame signals, so it stays reactive inside a computed.
   */
  folderOwnershipFromCache(folderPath: string): FolderOwnershipState | null {
    const { files, capped, total } = selectOwnershipFiles(
      this._entries(),
      folderPath,
      FOLDER_OWNERSHIP_CAP,
    );
    if (files.length === 0) return null;
    const blames = this._blames();
    const owners: BlameOwner[] = [];
    const perFile: { path: string; lines: readonly BlameOwner[] }[] = [];
    for (const entry of files) {
      const blame = blames.get(fileKey(entry.path, null));
      if (!blame || blame.status !== 'ready') return null;
      owners.push(...blame.lines);
      perFile.push({ path: entry.path, lines: blame.lines });
    }
    return {
      status: 'ready',
      path: folderPath,
      summary: summarizeOwnership(owners),
      riskFiles: computeOwnershipRisk(perFile),
      filesTotal: files.length,
      filesScanned: files.length,
      matchedTotal: total,
      capped,
      files: files.map((f) => f.path),
      fromCache: true,
    };
  }

  /**
   * Blames every file under `folderPath` (capped — this is request-heavy) and
   * folds their attribution into one authorship summary, publishing after each
   * file so the panel fills in progressively. Reuses the per-file blame cache,
   * so files already annotated are free, and is cancelled by navigation or a
   * superseding scan via the run/sequence guards.
   */
  async computeFolderOwnership(folderPath: string, options?: { all?: boolean }): Promise<void> {
    if (this._phase() !== 'ready') return;
    const cap = options?.all ? Number.POSITIVE_INFINITY : FOLDER_OWNERSHIP_CAP;
    const { files, capped, total } = selectOwnershipFiles(this._entries(), folderPath, cap);
    const paths = files.map((f) => f.path);

    const run = ++this.folderRun;
    const seq = this.loadSeq;
    const live = (): boolean => seq === this.loadSeq && run === this.folderRun;

    const owners: BlameOwner[] = [];
    const perFile: { path: string; lines: readonly BlameOwner[] }[] = [];
    let scanned = 0;
    const publish = (status: FolderOwnershipState['status'], message?: string): void =>
      this._folderOwnership.set({
        status,
        path: folderPath,
        summary: summarizeOwnership(owners),
        riskFiles: computeOwnershipRisk(perFile),
        filesTotal: files.length,
        filesScanned: scanned,
        matchedTotal: total,
        capped,
        files: paths,
        message,
      });

    if (files.length === 0) {
      publish('ready', 'No files in this folder.');
      return;
    }

    publish('computing');

    // Blaming each file first needs that file's history. Providers that read a
    // full local database can precompute every path's history in one walk —
    // far cheaper than the per-file history requests this loop would otherwise
    // fire (one whole-history walk per file). Done under the 'computing' state
    // so the panel shows progress meanwhile. Best-effort: networked providers
    // don't implement it, and a failure just falls back to per-file loading.
    const slug = this._slug();
    if (slug) {
      const provider = this.registry.byId(slug.provider);
      if (provider.primeHistories) {
        try {
          await provider.primeHistories(slug, this.ref() ?? 'HEAD');
        } catch {
          // Ignore — blame will load each file's history the slower way.
        }
        if (!live()) return;
      }
    }

    // Blame the files with bounded concurrency: each file's blame is independent,
    // so overlapping a handful turns N sequential history+blob walks into roughly
    // N / limit. The summary and risk list aggregate and re-sort their inputs, so
    // the published result is identical regardless of which file finishes first.
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (!live()) return;
        const i = next++;
        if (i >= files.length) return;
        const entry = files[i];
        await this.loadBlame(entry.path, null);
        if (!live()) return;
        const blame = this._blames().get(fileKey(entry.path, null));
        if (blame && (blame.status === 'ready' || blame.status === 'computing')) {
          owners.push(...blame.lines);
          perFile.push({ path: entry.path, lines: blame.lines });
        }
        scanned++;
        publish('computing');
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(FOLDER_OWNERSHIP_CONCURRENCY, files.length) }, () => worker()),
    );
    if (!live()) return;
    publish('ready');
  }

  /** Drops both co-change results (repo-wide + filter) and cancels their walks. */
  clearCoChange(): void {
    this.coChangeRun++;
    this.focusRun++;
    this._coChange.set(null);
    this._coupleFocus.set(null);
  }

  /** Removes the coupling file filter, keeping the repo-wide analysis intact. */
  clearCoupleFocus(): void {
    this.focusRun++;
    this._coupleFocus.set(null);
  }

  /** Drops the survival analysis and cancels its walk. */
  clearSurvival(): void {
    this.survivalRun++;
    this._survival.set(null);
    this.survivalLifetimes = null;
  }

  /**
   * Re-bucket the Age cohort stack (week / month / year) without re-walking
   * history: only the finished report's cohort stack is rebuilt from the retained
   * lifetimes (O(lines)). A no-op when nothing has been analysed yet; a walk in
   * flight picks up the new granularity on its next streamed publish.
   */
  setCohortBucket(bucket: CohortBucket): void {
    if (this._cohortBucket() === bucket) return;
    this._cohortBucket.set(bucket);
    const state = this._survival();
    const lines = this.survivalLifetimes;
    // Re-bucket for any *terminal* state with retained lifetimes — a finished
    // walk ('ready') or one stopped early ('error') whose partial report is still
    // on screen. An in-flight walk ('reading'/'computing') is left alone: its
    // next streamed publish already re-buckets, and its lifetimes are partial.
    if (!state || !lines || (state.status !== 'ready' && state.status !== 'error')) return;
    // Only the cohort stack depends on the grain — keep the (unchanged) curve,
    // author shares and counts so a slider move stays O(lines), never a full
    // Kaplan–Meier re-sort that could freeze the tab on a large repo.
    const cohorts = cohortStackFor(lines, this.survivalNow, bucket);
    this._survival.set({ ...state, report: { ...state.report, cohorts } });
  }

  /**
   * Repo-wide co-change: walks recent commits (up to
   * {@link CO_CHANGE_COMMIT_CAP}, or the whole history with `all`) and surfaces
   * hotspots plus the strongest coupling overall.
   */
  computeCoChange(options?: { all?: boolean }): Promise<void> {
    return this.walkCoChange({
      cap: options?.all ? Number.POSITIVE_INFINITY : CO_CHANGE_COMMIT_CAP,
      target: 'overview',
    });
  }

  /**
   * Filters coupling by a file: walks `path`'s **full** history (one file, so
   * usually far fewer commits than the repo) for the complete list of what
   * changes together with it. Published separately, so the repo-wide overview
   * survives and the filter can be cleared.
   */
  computeCoChangeFor(path: string): Promise<void> {
    return this.walkCoChange({
      path,
      focus: path,
      cap: FILE_COCHANGE_COMMIT_CAP,
      minSupport: 1,
      target: 'focus',
    });
  }

  /**
   * The shared co-change walk: pages commits (optionally limited to `path`),
   * fetches each one's changed files (cached per sha — request-heavy) and folds
   * them into temporal coupling, publishing as it streams to the overview or
   * filter signal. Cancelled by navigation or a superseding run via the guards.
   */
  private async walkCoChange(options: {
    readonly cap: number;
    readonly target: 'overview' | 'focus';
    readonly path?: string;
    readonly focus?: string;
    readonly minSupport?: number;
  }): Promise<void> {
    const slug = this._slug();
    if (!slug || this._phase() !== 'ready') return;
    const provider = this.registry.byId(slug.provider);
    const ref = this.ref() ?? undefined;

    const sink = options.target === 'focus' ? this._coupleFocus : this._coChange;
    const seq = this.loadSeq;
    const run = options.target === 'focus' ? ++this.focusRun : ++this.coChangeRun;
    const live = (): boolean =>
      seq === this.loadSeq &&
      run === (options.target === 'focus' ? this.focusRun : this.coChangeRun);

    // File sizes from the tree drive the hotspot treemap rectangles.
    const sizes = new Map<string, number>();
    for (const entry of this._entries()) {
      if (entry.kind === 'file') sizes.set(entry.path, entry.size ?? 0);
    }

    // Each commit keeps its date/author (for churn scoring and the team graph)
    // and changed files.
    const collected: (CommitFiles & {
      authoredAt: string;
      authorName: string;
      authorEmail: string | null;
      deletions: number;
    })[] = [];
    // Generated/vendored files are held out of every metric, but a file the
    // analysis is focused on is always kept (the user chose it explicitly).
    const keepFile = (path: string): boolean => path === options.focus || !isGeneratedFile(path);
    // Set once the provider runs out of history, so a walk that ends exactly at
    // the cap is reported complete rather than partial.
    let exhausted = false;

    // Snapshot the walk so far as worker input: drop generated/vendored files
    // (counted so the header can note them) and mark the knowledge partial while
    // older history may still be unread.
    let excludedCount = 0;
    const snapshot = (status: CoChangeState['status']): AggregateInput => {
      const excluded = new Set<string>();
      const commits = collected.map((commit) => ({
        sha: commit.sha,
        authoredAt: commit.authoredAt,
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        deletions: commit.deletions,
        files: commit.files.filter((path) => {
          if (keepFile(path)) return true;
          excluded.add(path);
          return false;
        }),
      }));
      excludedCount = excluded.size;
      const partial = status !== 'ready' || (!exhausted && collected.length >= options.cap);
      return { commits, sizes, focus: options.focus, minSupport: options.minSupport, partial };
    };

    const stateFrom = (
      status: CoChangeState['status'],
      agg: AggregateResult,
      message?: string,
    ): CoChangeState => ({
      status,
      focus: options.focus,
      scanned: collected.length,
      target: options.cap,
      result: agg.result,
      // Hotspots, the team graph, knowledge and the forecast are repo-wide
      // metrics; a single file's focused walk doesn't have them.
      hotspots: agg.hotspots,
      teamGraph: agg.teamGraph,
      knowledge: agg.knowledge,
      forecast: options.focus ? undefined : agg.forecast,
      commitTimes: options.focus ? undefined : collected.map((commit) => commit.authoredAt),
      excludedFiles: excludedCount || undefined,
      message,
    });

    // The heavy aggregation runs off the main thread (a Web Worker, when
    // available) without queueing: a request while one is in flight just
    // supersedes the previous, and the terminal 'ready'/'error' run is awaited
    // so the published state always reflects every commit walked. Stale runs
    // from a superseded walk are dropped by the `live()` guard.
    let running: Promise<void> | null = null;
    let queued: { status: CoChangeState['status']; message?: string } | null = null;
    const pump = (status: CoChangeState['status'], message?: string): Promise<void> => {
      queued = { status, message };
      running ??= (async () => {
        try {
          while (queued && live()) {
            const next = queued;
            queued = null;
            const agg = await this.analysis.run(snapshot(next.status));
            if (!live()) return;
            sink.set(stateFrom(next.status, agg, next.message));
          }
        } finally {
          running = null;
        }
      })();
      return running;
    };

    // A synchronous first frame so the view shows progress immediately; the
    // heavy aggregation streams in off-thread.
    sink.set(stateFrom('computing', EMPTY_AGGREGATE));
    try {
      for (let page = 1; collected.length < options.cap; page++) {
        const commits = await provider.listCommits(slug, {
          ref,
          path: options.path,
          perPage: HISTORY_PAGE_SIZE,
          page,
        });
        if (!live()) return;
        if (commits.length === 0) {
          exhausted = true;
          break;
        }
        this.cacheCommits(commits);
        const before = collected.length;
        // Pipeline the per-commit changed-file fetches with bounded concurrency,
        // so the requests overlap instead of running strictly one at a time (the
        // dominant cost of this walk). Bounded by the remaining cap as well as the
        // window, so a partial last page never starts fetches it won't consume —
        // those would be wasted provider quota on hosted repos.
        const pageMax = Math.min(commits.length, options.cap - before);
        const pending: (Promise<readonly CommitFileChange[]> | undefined)[] = new Array(pageMax);
        let started = 0;
        const fill = (limit: number): void => {
          const max = Math.min(pageMax, limit);
          while (started < max) {
            const promise = this.commitFilesFor(slug, commits[started].sha);
            void promise.catch(() => {}); // handled; the in-order await still surfaces the error
            pending[started++] = promise;
          }
        };
        fill(CO_CHANGE_PREFETCH);
        for (let i = 0; i < pageMax; i++) {
          const changes = await pending[i]!;
          pending[i] = undefined;
          if (!live()) return;
          fill(i + 1 + CO_CHANGE_PREFETCH); // keep the request window full
          const commit = commits[i];
          collected.push({
            sha: commit.sha,
            authoredAt: commit.authoredAt,
            authorName: commit.authorName,
            authorEmail: commit.authorEmail,
            files: changes.map((change) => change.path),
            // Count removed lines only on files that survive the generated/vendored
            // filter, so lockfile/build-output churn can't win "top code eliminator".
            deletions: changes.reduce(
              (sum, change) => sum + (keepFile(change.path) ? (change.deletions ?? 0) : 0),
              0,
            ),
          });
          if (collected.length % 5 === 0) void pump('computing');
        }
        // A short page is the end of history — but only when the cap didn't
        // stop us partway through it. If we broke at the cap mid-page, older
        // commits from this same page are still unread: the walk is partial.
        if (collected.length - before === commits.length && commits.length < HISTORY_PAGE_SIZE) {
          exhausted = true;
          break;
        }
      }
      const empty = options.path ? 'No history found for this file.' : 'No commit history found.';
      await pump('ready', collected.length === 0 ? empty : undefined);
    } catch (error) {
      if (!live()) return; // a cleared/superseded walk must not resurrect state
      await pump('error', toRepoProviderError(error).message);
    }
  }

  /**
   * Code survival & age cohorts ("Git of Theseus"): walks the **whole** history
   * forward, keeping a cohort tag per live line of every file. Each commit's
   * changed files are re-fetched and diffed against the running snapshot — added
   * lines are born, removed lines die (recording their lifetime), survivors at
   * the tip are right-censored — and the lifetimes folded into the cohort stack,
   * the authorship share and a Kaplan–Meier survival curve. One content request
   * per changed file per commit, so it is heavy on hosted providers (add a token)
   * and cheap on local repositories. Streams as it goes; cancelled by navigation
   * or a superseding run.
   */
  async computeSurvival(): Promise<void> {
    const slug = this._slug();
    if (!slug || this._phase() !== 'ready') return;
    const provider = this.registry.byId(slug.provider);
    const ref = this.ref() ?? undefined;

    const run = ++this.survivalRun;
    const seq = this.loadSeq;
    const live = (): boolean => seq === this.loadSeq && run === this.survivalRun;

    /** A cohort tag shared by every line one commit introduces. */
    interface Tag {
      readonly bornAt: number;
      readonly author: string;
    }
    /** The running snapshot of one file: its current lines and their owning tags. */
    interface Tracked {
      lines: string[];
      tags: Tag[];
    }

    const dead: LineLifetime[] = [];
    const files = new Map<string, Tracked>();
    let scanned = 0;
    let total = 0;

    // Lifetimes = recorded deaths + every still-live tag (censored at the tip).
    const lifetimes = (): LineLifetime[] => {
      const all = dead.slice();
      for (const tracked of files.values()) {
        for (const tag of tracked.tags) {
          all.push({ bornAt: tag.bornAt, author: tag.author, diedAt: null });
        }
      }
      return all;
    };

    // Survivors are right-censored at the tip commit's time, not wall-clock now,
    // so an archived or old ref is not read as if its code survived until today.
    let now = Date.now();
    // Retain the lifetimes + tip time so the cohort granularity can be changed
    // afterwards (setCohortBucket) without re-walking — only the report's cohort
    // stack is rebuilt. Reads the current bucket so a change mid-walk takes hold
    // on the next streamed publish too.
    const reportFrom = (): SurvivalReport => {
      const lines = lifetimes();
      this.survivalLifetimes = lines;
      this.survivalNow = now;
      return summarizeSurvival(lines, { now, bucket: this._cohortBucket() });
    };
    let report = reportFrom();
    const publish = (status: SurvivalState['status'], message?: string): void =>
      this._survival.set({ status, scanned, total, report, message });

    publish('reading', 'Reading history…');
    try {
      // 1. Page the whole history (cheap metadata), then walk it oldest-first.
      const commits: CommitInfo[] = [];
      for (let page = 1; ; page++) {
        const batch = await provider.listCommits(slug, { ref, perPage: HISTORY_PAGE_SIZE, page });
        if (!live()) return;
        if (batch.length === 0) break;
        this.cacheCommits(batch);
        commits.push(...batch);
        total = commits.length;
        publish('reading', `Reading history… ${commits.length} commits`);
        if (batch.length < HISTORY_PAGE_SIZE) break;
      }
      if (commits.length === 0) {
        publish('ready', 'No commit history found.');
        return;
      }

      // Walk the **first-parent chain** (a clean linear sequence of tree states),
      // so side-branch commits fold into the merge that brings them to the
      // mainline instead of being applied to the snapshot out of order. Some
      // providers omit parents in their commit lists (e.g. Azure DevOps); resolve
      // them on demand so the chain stays real rather than collapsing to a guess.
      const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
      const chain: CommitInfo[] = [];
      const seen = new Set<string>();
      let cursor: CommitInfo | undefined = commits[0]; // newest reachable = the tip
      while (cursor && !seen.has(cursor.sha)) {
        seen.add(cursor.sha);
        chain.push(cursor);
        let parents: readonly string[] = cursor.parentShas;
        if (parents.length === 0) {
          parents = (await this.resolveCommit(slug, cursor.sha)).parentShas;
          if (!live()) return;
        }
        const parent: string | undefined = parents[0];
        cursor = parent ? bySha.get(parent) : undefined;
      }
      const walk = chain.reverse(); // oldest → newest along the mainline
      total = walk.length;
      const tipTime = Date.parse(commits[0].authoredAt);
      if (!Number.isNaN(tipTime)) now = tipTime;

      // 2. Forward walk. The per-commit changed-file lists (carrying GitHub's
      // inline patches) are prefetched with bounded concurrency so the requests
      // overlap instead of running one at a time, and each file's new content is
      // rebuilt from its patch — so the common path makes no per-file blob
      // request at all (one request per commit instead of one per changed file).
      const fileLists: (Promise<readonly CommitFileChange[]> | undefined)[] = new Array(
        walk.length,
      );
      let started = 0;
      const prefetch = (limit: number): void => {
        while (started < walk.length && started < limit) {
          const promise = provider.getCommitFiles(slug, walk[started].sha);
          void promise.catch(() => {}); // mark handled; the in-order await still surfaces the error
          fileLists[started++] = promise;
        }
      };
      prefetch(SURVIVAL_PREFETCH);

      let walkClock = Number.NEGATIVE_INFINITY;
      let lastPublish = Date.now();
      for (let index = 0; index < walk.length; index++) {
        const commit = walk[index];
        // A provider failure (rate limit, network) must surface as an error, not
        // be swallowed into an empty change set that silently corrupts the report.
        const changes = await fileLists[index]!;
        fileLists[index] = undefined; // release the buffered result
        if (!live()) return;
        prefetch(index + 1 + SURVIVAL_PREFETCH); // keep the request window full

        const authored = Date.parse(commit.authoredAt);
        // Clamp commit times to be monotonically non-decreasing along the chain,
        // so a rebased / cherry-picked / backdated commit can never record a death
        // before the line's birth (diedAt < bornAt → negative cohort counts). An
        // undated commit still applies (keeping the snapshot in sync) — it borrows
        // the running clock rather than being skipped.
        if (!Number.isNaN(authored)) walkClock = Math.max(walkClock, authored);
        const commitTime = Number.isFinite(walkClock) ? walkClock : 0;
        now = commitTime; // censor survivors at the latest observed commit, not wall-clock now
        const tag: Tag = { bornAt: commitTime, author: commit.authorName };

        // Resolve each change against the **pre-commit** snapshot (we don't mutate
        // `files` until the whole commit is computed). New content comes from the
        // inline patch when present, else a blob fetch.
        // A tracked file can leave the analyzed set *without dying* — when it is
        // renamed into a generated/ignored path (e.g. `git mv src/app.ts
        // dist/app.js`). Those lines are **censored** (observed alive until now,
        // then unobservable), never counted as deaths and never left tracked on
        // the vacated source path.
        const movedIntoIgnored: string[] = []; // source paths vacated into an ignored path
        const ignoredAdds: CommitFileChange[] = []; // generated adds — possible move sinks
        const linesEqual = (a: readonly string[], b: readonly string[]): boolean =>
          a.length === b.length && a.every((line, i) => line === b[i]);
        const censorIntoIgnored = (tags: readonly Tag[], sourcePath: string): void => {
          for (const owner of tags) {
            if (owner) {
              dead.push({
                bornAt: owner.bornAt,
                author: owner.author,
                diedAt: null,
                censoredAt: commitTime,
              });
            }
          }
          movedIntoIgnored.push(sourcePath);
        };

        const resolved: {
          change: CommitFileChange;
          movedFrom: string | null;
          oldLines: readonly string[];
          oldTags: Tag[];
          newLines: readonly string[] | null; // null = binary / too large
          skip: boolean;
        }[] = [];
        for (const change of changes) {
          // Hold generated/vendored files (lockfiles, dist/, minified bundles …)
          // out of the lifetimes, exactly as the rest of Insights does, so they
          // don't dominate the cohort, half-life and authorship charts.
          if (isGeneratedFile(change.path)) {
            // A tracked file renamed straight into an ignored path: censor its
            // lines and vacate the old path rather than record false deaths. A
            // provider reports this as one rename (previousPath set); a local
            // `git mv` splits it into this ignored add plus a separate removal we
            // reconcile by content below. Plain generated adds/edits never enter
            // the lifetimes at all.
            const src =
              change.previousPath && change.previousPath !== change.path
                ? change.previousPath
                : null;
            const tracked = src ? files.get(src) : undefined;
            if (tracked) censorIntoIgnored(tracked.tags, src!);
            else if (!change.previousPath && /^add|copy/i.test(change.status))
              ignoredAdds.push(change);
            continue;
          }
          // Only a **rename** carries the source's tracked snapshot; a **copy** or
          // a freshly **added** file starts from empty.
          const isCopy = /copy|copied/i.test(change.status);
          const movedFrom =
            !isCopy && change.previousPath && change.previousPath !== change.path
              ? change.previousPath
              : null;
          const isAdd = !change.previousPath && /^add/i.test(change.status);
          const previous = isAdd ? undefined : files.get(movedFrom ?? change.path);
          const oldLines = previous?.lines ?? [];
          const oldTags = previous?.tags ?? [];
          const newLines = await this.resolveNewLines(change, oldLines, commit.sha);
          if (!live()) return;
          resolved.push({ change, movedFrom, oldLines, oldTags, newLines, skip: false });
        }

        // Detect renames the provider didn't flag — notably a local `git mv`,
        // which the isomorphic-git reader reports as a plain remove + add with no
        // `previousPath`. Pairing carries the lines' age/author across the move
        // instead of recording deaths and rebirths (which would reset code age on
        // the repos we advertise as the cheap path).
        type Resolved = (typeof resolved)[number];
        const isRemovedSource = (r: Resolved): boolean =>
          !r.movedFrom &&
          r.oldLines.length > 0 &&
          r.newLines !== null &&
          r.newLines.length === 0 &&
          /remov|delet/i.test(r.change.status);
        // A rename target the provider didn't flag: a freshly **added** file, or a
        // **modified** file that a `git mv -f old existing` overwrote with the
        // source's content (its own pre-commit lines are then retired).
        const isAddedTarget = (r: Resolved): boolean =>
          !r.change.previousPath &&
          /^add/i.test(r.change.status) &&
          r.newLines !== null &&
          r.newLines.length > 0;
        const isOverwriteTarget = (r: Resolved): boolean =>
          !r.change.previousPath &&
          /modif|chang/i.test(r.change.status) &&
          r.newLines !== null &&
          r.newLines.length > 0 &&
          // The content must really have changed. A mode-only / no-op "modified"
          // entry still holds its own lines, so pairing a deleted duplicate into
          // it would wrongly retire that file's lines and swap its age/author for
          // the deletion's.
          !linesEqual(r.oldLines, r.newLines);
        const pairRename = (target: Resolved, source: Resolved): void => {
          // An overwritten (modified) target's own pre-commit lines die here; an
          // added target has none. The target then carries the source's snapshot,
          // so its content keeps the moved lines' age and author.
          for (const owner of target.oldTags) {
            if (owner) {
              dead.push({ bornAt: owner.bornAt, author: owner.author, diedAt: commitTime });
            }
          }
          target.movedFrom = source.change.path; // the source path is vacated by the rename
          target.oldLines = source.oldLines;
          target.oldTags = source.oldTags;
          source.skip = true; // its removal *is* the rename, not a deletion
        };

        // A local `git mv` of a tracked file into an ignored path arrives as a
        // removal plus the ignored add collected above (no previousPath linking
        // them). Match the add's content to an unpaired removed source and censor
        // it — those lines left the analyzed set, they did not die. Runs before
        // the rename passes so a censored source can't also be paired as a normal
        // move, and only when such a move is possible, so ordinary lockfile/dist
        // churn (no coincident removal) still costs nothing.
        if (ignoredAdds.length > 0) {
          const removedSources = resolved.filter((r) => isRemovedSource(r) && !r.skip);
          if (
            removedSources.length > 0 &&
            ignoredAdds.length * removedSources.length <= SURVIVAL_RENAME_PAIR_LIMIT
          ) {
            const byContent = new Map<string, Resolved[]>();
            for (const r of removedSources) {
              const key = r.oldLines.join('\n');
              const queue = byContent.get(key);
              if (queue) queue.push(r);
              else byContent.set(key, [r]);
            }
            for (const add of ignoredAdds) {
              const lines = await this.resolveNewLines(add, [], commit.sha);
              if (!live()) return;
              if (lines === null || lines.length === 0) continue;
              const source = byContent.get(lines.join('\n'))?.shift();
              if (source) {
                source.skip = true; // its removal *is* the move into the ignored path
                censorIntoIgnored(source.oldTags, source.change.path);
              }
            }
          }
        }

        // 1) Exact content (a pure `git mv`, incl. mass moves of identical files
        // and overwrite targets) — cheap, matched through a per-content **queue**
        // so several identical sources each pair with their own target.
        const removedByContent = new Map<string, Resolved[]>();
        for (const item of resolved) {
          if (!isRemovedSource(item) || item.skip) continue; // a source censored into an ignored path is spent
          const key = item.oldLines.join('\n');
          const queue = removedByContent.get(key);
          if (queue) queue.push(item);
          else removedByContent.set(key, [item]);
        }
        if (removedByContent.size > 0) {
          for (const item of resolved) {
            if (item.movedFrom || (!isAddedTarget(item) && !isOverwriteTarget(item))) continue;
            const queue = removedByContent.get(item.newLines!.join('\n'));
            if (!queue) continue;
            let source: Resolved | undefined;
            while (queue.length > 0) {
              const candidate = queue.shift()!;
              if (!candidate.skip && candidate !== item) {
                source = candidate;
                break;
              }
            }
            if (source) pairRename(item, source);
          }
        }

        // 2) Similarity (a rename that also edited the file) — bounded greedy
        // best-match above a threshold, like git's own rename detection. Only
        // **added** targets, so a routine edit isn't mistaken for a move-overwrite.
        const looseRemoved = resolved.filter((r) => isRemovedSource(r) && !r.skip);
        const looseAdded = resolved.filter((r) => isAddedTarget(r) && !r.movedFrom);
        if (
          looseRemoved.length > 0 &&
          looseAdded.length > 0 &&
          looseRemoved.length * looseAdded.length <= SURVIVAL_RENAME_PAIR_LIMIT
        ) {
          const candidates: { added: Resolved; source: Resolved; score: number }[] = [];
          for (const added of looseAdded) {
            const newText = added.newLines!.join('\n');
            for (const source of looseRemoved) {
              const score = lineSimilarity(source.oldLines.join('\n'), newText);
              if (score >= SURVIVAL_RENAME_SIMILARITY) candidates.push({ added, source, score });
            }
          }
          candidates.sort((a, b) => b.score - a.score);
          for (const { added, source } of candidates) {
            if (added.movedFrom || source.skip) continue; // each side pairs at most once
            pairRename(added, source);
          }
        }

        // Apply (staged): deletes before sets, so a path a rename vacated but
        // another change re-created in the same commit keeps the new file.
        const sets: [string, Tracked][] = [];
        const deletes: string[] = [...movedIntoIgnored]; // paths vacated by a move into an ignored path
        for (const { change, movedFrom, oldLines, oldTags, newLines, skip } of resolved) {
          if (skip) continue;
          if (newLines === null) {
            // Binary or past the size guard: the blob can't be read, but nothing
            // was deleted. Right-**censor** its tracked lines at this commit
            // (observed alive until now, then unobservable) instead of inventing
            // deaths or dropping them silently, then stop following the file.
            for (const owner of oldTags) {
              if (owner) {
                dead.push({
                  bornAt: owner.bornAt,
                  author: owner.author,
                  diedAt: null,
                  censoredAt: commitTime,
                });
              }
            }
            if (movedFrom) deletes.push(movedFrom);
            deletes.push(change.path);
            continue;
          }

          const ops = diffLines(oldLines, newLines);
          // A block moved within the file surfaces as remove+add; carry its tag
          // (no death, no rebirth) as blame does, so a refactor keeps its age.
          const moved = movedLinePairs(ops);
          const movedOld = new Set(moved.values());
          const newTags: Tag[] = [];
          for (const op of ops) {
            if (op.kind === 'equal') {
              newTags.push(oldTags[op.oldLine - 1]);
            } else if (op.kind === 'remove') {
              if (movedOld.has(op.oldLine)) continue; // moved within the file, not dead
              const owner = oldTags[op.oldLine - 1];
              if (owner) {
                dead.push({ bornAt: owner.bornAt, author: owner.author, diedAt: commitTime });
              }
            } else {
              const fromOld = moved.get(op.newLine);
              newTags.push(fromOld !== undefined ? oldTags[fromOld - 1] : tag);
            }
          }

          if (movedFrom) deletes.push(movedFrom); // a rename empties the old path
          if (newLines.length === 0) deletes.push(change.path);
          else sets.push([change.path, { lines: [...newLines], tags: newTags }]);
        }
        for (const path of deletes) files.delete(path);
        for (const [path, tracked] of sets) files.set(path, tracked);

        scanned++;
        // Recompute/stream the report on a time budget, not every commit, so the
        // O(lines) roll-up can't dominate a long walk.
        const elapsed = Date.now();
        if (elapsed - lastPublish >= SURVIVAL_PUBLISH_MS) {
          report = reportFrom();
          lastPublish = elapsed;
          publish('computing');
        }
      }

      report = reportFrom();
      publish(
        'ready',
        report.trackedLines === 0 ? 'No text lines found in this history.' : undefined,
      );
    } catch (error) {
      if (!live()) return; // a cleared/superseded walk must not resurrect state
      report = reportFrom();
      this._survival.set({
        status: 'error',
        scanned,
        total,
        report,
        message: toRepoProviderError(error).message,
      });
    }
  }

  /**
   * A changed file's lines just after a commit, for the survival walk — derived
   * **without a network request** whenever possible:
   *
   * - a removal → `[]`; a no-content-change (pure rename / mode edit) → the old
   *   lines unchanged;
   * - otherwise the provider's inline `patch` is applied to `oldLines` (the fast
   *   path: GitHub ships the diff with the commit, so no blob is fetched) — but
   *   only when its hunks apply cleanly **and** the added/removed line totals
   *   match the provider's per-file stats, so a patch truncated between hunks
   *   (a valid prefix of a larger diff) can't be mistaken for the whole thing;
   * - failing that it falls back to {@link survivalNewLines} (a blob fetch).
   *   `null` means a binary / oversized blob that can't be followed.
   */
  private async resolveNewLines(
    change: CommitFileChange,
    oldLines: readonly string[],
    sha: string,
  ): Promise<readonly string[] | null> {
    if (/remov|delet/i.test(change.status)) return [];
    // "No content change" carries the old lines — but a **copy** has no tracked
    // old side (its `oldLines` is the empty target), so it must still fetch the
    // copied content to record those lines as new births.
    const isCopy = /copy|copied/i.test(change.status);
    if (!isCopy && change.additions === 0 && change.deletions === 0) return oldLines;
    if (change.patch !== undefined) {
      const hunks = parsePatch(change.patch);
      const applied = applyPatch(oldLines, hunks);
      if (applied && patchStatsMatch(hunks, change)) return applied; // whole diff, in hand
    }
    return this.survivalNewLines(change, sha);
  }

  /**
   * The text lines of a changed file just after a commit, fetched from the blob:
   * `[]` when the file was removed (or is genuinely absent at that commit), or
   * `null` when it is binary / too large and should stop being tracked. Fetches
   * the blob directly (bypassing the UI file cache) so a full-history walk does
   * not flood it. **Only** an expected `not-found` maps to empty — any other
   * provider failure (rate limit, network) is re-thrown so the walk fails loudly
   * instead of recording the file's lines as falsely deleted.
   */
  private async survivalNewLines(change: CommitFileChange, sha: string): Promise<string[] | null> {
    if (/remov|delet/i.test(change.status)) return [];
    const slug = this._slug();
    if (!slug) return null;
    try {
      const file = await this.registry.byId(slug.provider).getFileAtRef(slug, change.path, sha);
      return file.kind === 'text' ? splitLines(file.text) : null; // null = binary / too large
    } catch (error) {
      if (toRepoProviderError(error).kind === 'not-found') return []; // expected absence
      throw error; // rate limit / network / unknown → surface, don't corrupt the report
    }
  }

  /** Changed files of a commit (with line stats), cached per sha (shared across walks). */
  private commitFilesFor(slug: RepoSlug, sha: string): Promise<readonly CommitFileChange[]> {
    const cached = this.commitFilesCache.get(sha);
    if (cached) return cached;
    const promise = this.registry.byId(slug.provider).getCommitFiles(slug, sha);
    this.commitFilesCache.set(sha, promise);
    promise.catch(() => this.commitFilesCache.delete(sha));
    return promise;
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
    const hits = [...state.hits];
    let scanned = state.scanned;
    const publish = (patch: Partial<LineTraceState>): void =>
      this._lineTrace.set({
        ...this._lineTrace()!,
        commits: [...commits],
        hits: [...hits],
        scanned,
        ...patch,
      });
    const finish = (origin: LineTraceState['origin']): void => {
      this.traceResume = null;
      publish({ status: 'ready', truncated: false, origin });
    };
    const recordHit = (commit: CommitInfo, hitRange: LineRange): void => {
      commits.push(commit);
      hits.push({ commit, path, range: hitRange });
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
        recordHit(newer, r);
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
      if (olderFile.status === 'error' && olderFile.kind === 'not-found') {
        // The file is absent at `older` (deleted there and re-added since), so
        // `newer` (re)introduced the tracked lines — the trail ends with it,
        // just as at the file's creation, rather than erroring out.
        recordHit(newer, r);
        scanned++;
        finish({ sha: newer.sha, range: r });
        return;
      }
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
        recordHit(newer, r);
        scanned++;
        finish({ sha: newer.sha, range: r });
        return;
      }

      const olderLines = splitLines(olderFile.file.text);
      const ops = diffLines(olderLines, newerLines);
      const regions = changeRegions(ops);
      if (regions.some((region) => regionTouchesRange(region, r))) recordHit(newer, r);
      scanned++;

      const mapped = followRange(ops, r);
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

      const tracedText = blockState.file.text;
      const candidates: HunkOriginCandidate[] = [];
      let scanned = 0;
      const publish = (status: 'searching' | 'ready'): void => {
        // Block match first; among equally-good hits, the file most similar to
        // the traced one is the likelier source, so it surfaces on top.
        const top = [...candidates]
          .sort((a, b) => b.score - a.score || b.fileSimilarity - a.fileSimilarity)
          .slice(0, ORIGIN_RESULT_CAP);
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
              fileSimilarity: lineSimilarity(state.file.text, tracedText),
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
    this._compareBase.set(null);
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

  /**
   * Records the recency-weighted change metric for a file from its loaded
   * history, so the file tree can show a hotspot badge. `hasMore` marks the
   * metric partial (the revision count is then a lower bound).
   */
  private recordMetric(path: string, commits: readonly CommitInfo[], hasMore: boolean): void {
    const metric = computeFileMetric(commits, { partial: hasMore });
    const next = new Map(this._fileMetrics());
    next.set(path, metric);
    this._fileMetrics.set(next);
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
      (current.host ?? null) === (slug.host ?? null) &&
      current.owner.toLowerCase() === slug.owner.toLowerCase() &&
      current.repo.toLowerCase() === slug.repo.toLowerCase() &&
      (this._requestedRef() ?? null) === ref
    );
  }

  /** Same repository (provider/host/owner/repo), regardless of the ref being loaded. */
  private isSameRepo(current: RepoSlug | null, slug: RepoSlug): boolean {
    return (
      !!current &&
      current.provider === slug.provider &&
      (current.host ?? null) === (slug.host ?? null) &&
      current.owner.toLowerCase() === slug.owner.toLowerCase() &&
      current.repo.toLowerCase() === slug.repo.toLowerCase()
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

/**
 * Cache key for a diff state. `base`, when set, diffs `path@at` against that
 * predecessor path at the parent (a chosen rename candidate) rather than the
 * commit's own changes, so the two are cached separately. The NUL separator
 * cannot occur in a git path, keeping the keys unambiguous.
 */
function diffStateKey(path: string, at: string, base: string | null): string {
  return base ? `${fileKey(path, at)}\u0000${base}` : fileKey(path, at);
}
