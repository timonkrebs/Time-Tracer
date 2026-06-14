import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { LocalRepos } from '../../core/git/local/local-repos';
import {
  CO_CHANGE_COMMIT_CAP,
  FOLDER_OWNERSHIP_CAP,
  HunkOriginCandidate,
  LineTraceHit,
  RenameCandidate,
  RepoStore,
} from '../../core/store/repo-store';
import { LineRange, formatLineRange, parseLineRange } from '../../core/util/line-range';
import { relativeTime, shortSha } from '../../core/util/relative-time';
import { DiffView } from './diff-view';
import { FileFinder } from './file-finder';
import { FileHistory } from './file-history';
import { FileTree } from './file-tree';
import { FileView } from './file-view';
import { InsightsView } from './insights-view';
import { OwnershipPanel } from './ownership-panel';

const TREE_WIDTH_KEY = 'time-tracer.tree-width';
const TREE_WIDTH_DEFAULT = 300;
const TREE_WIDTH_MIN = 200;
const TREE_WIDTH_MAX = 600;
const VIEW_MODE_KEY = 'time-tracer.view-mode';
const HISTORY_OPEN_KEY = 'time-tracer.history-open';
const TREE_COLLAPSED_KEY = 'time-tracer.tree-collapsed';
const OWNERS_OPEN_KEY = 'time-tracer.owners-open';

/**
 * `/r/:owner/:repo?ref=…&path=…&at=…&view=…&blame=…` — the split-pane
 * repository viewer.
 *
 * The route is the source of truth: owner/repo/ref drive `RepoStore.loadRepo`,
 * `path` drives file selection, `at` views that file at a historical commit,
 * `view` picks file vs. changes mode and `blame=0` disables line annotations —
 * so deep links, refreshes and browser back/forward all behave like real
 * navigation, including steps through time.
 */
@Component({
  selector: 'app-viewer-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    FileTree,
    FileView,
    FileHistory,
    DiffView,
    FileFinder,
    OwnershipPanel,
    InsightsView,
  ],
  host: { class: 'block h-full', '(document:keydown)': 'onGlobalKeydown($event)' },
  template: `
    <div class="flex h-full flex-col" [class.select-none]="dragging()">
      <header
        class="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-900/60 px-4"
      >
        @if (store.phase() === 'ready') {
          <button
            type="button"
            class="-ml-1 shrink-0 rounded p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
            (click)="toggleTree()"
            [attr.aria-label]="treeCollapsed() ? 'Show file tree' : 'Hide file tree'"
            [attr.aria-pressed]="!treeCollapsed()"
            [title]="treeCollapsed() ? 'Show file tree (t)' : 'Hide file tree (t)'"
          >
            <svg
              class="size-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18" />
            </svg>
          </button>
          <button
            type="button"
            class="shrink-0 rounded p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
            (click)="openFinder()"
            aria-label="Find a file"
            title="Find a file (Ctrl/⌘ P)"
          >
            <svg
              class="size-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </button>
          <button
            type="button"
            class="shrink-0 rounded p-1.5 transition"
            [class]="
              insightsMode()
                ? 'bg-indigo-500/20 text-indigo-200'
                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'
            "
            (click)="toggleInsights()"
            aria-label="Repository insights"
            [attr.aria-pressed]="insightsMode()"
            title="Insights — files that change together"
          >
            <svg
              class="size-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 3v18h18" />
              <path d="m7 14 4-4 3 3 5-5" />
            </svg>
          </button>
        }
        <a
          routerLink="/"
          class="flex shrink-0 items-center gap-2 text-zinc-100 transition hover:text-white"
        >
          <span
            class="flex size-6 items-center justify-center rounded-md border border-indigo-400/30 bg-indigo-500/10 text-indigo-300"
          >
            <svg
              class="size-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <path d="M3 4v4h4" />
              <path d="M12 7v5l3.5 2" />
            </svg>
          </span>
          <span class="text-sm font-semibold tracking-tight">Time Tracer</span>
        </a>

        <span class="text-zinc-700">/</span>

        <div class="flex min-w-0 items-center gap-2">
          @if (store.linksFor(); as links) {
            <a
              class="truncate font-mono text-sm text-zinc-300 transition hover:text-white hover:underline"
              [href]="links.repoUrl"
              target="_blank"
              rel="noopener noreferrer"
              >{{ store.metadata()?.fullName ?? owner() + '/' + repo() }}</a
            >
          } @else {
            <span class="truncate font-mono text-sm text-zinc-300">{{ owner() }}/{{ repo() }}</span>
          }
          @if (store.ref(); as currentRef) {
            <span
              class="flex shrink-0 items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 font-mono text-[11px] text-zinc-400"
            >
              <svg
                class="size-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <circle cx="6" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M6 9v6m12-6a9 9 0 0 1-9 9" />
                <circle cx="18" cy="6" r="3" />
              </svg>
              {{ currentRef }}
            </span>
          }
        </div>

        <span class="flex-1"></span>

        @if (store.phase() === 'ready') {
          <span class="hidden shrink-0 text-xs text-zinc-500 md:block">
            {{ store.fileCount() }} files · {{ store.dirCount() }} folders
          </span>
          @if (store.truncated()) {
            <span
              class="shrink-0 rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-300"
              title="The provider truncated the tree listing — some files may be missing."
            >
              partial tree
            </span>
          }
        }

        <a
          routerLink="/"
          class="shrink-0 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
        >
          New repository
        </a>
      </header>

      @if (store.phase() === 'error') {
        <div class="flex flex-1 items-center justify-center px-6">
          <div
            class="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center"
          >
            <div
              class="mx-auto mb-4 flex size-11 items-center justify-center rounded-full border border-rose-400/30 bg-rose-500/10 text-rose-300"
            >
              <svg
                class="size-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path
                  d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"
                />
                <path d="M12 9v4m0 4h.01" />
              </svg>
            </div>
            <h2 class="text-base font-semibold text-zinc-100">{{ errorTitle() }}</h2>
            <p class="mt-2 text-sm leading-6 text-zinc-400">{{ store.error()?.message }}</p>
            <div class="mt-6 flex items-center justify-center gap-3">
              @if (provider() === 'local') {
                <button
                  type="button"
                  class="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-400"
                  (click)="reconnectLocal()"
                >
                  Reconnect folder
                </button>
              } @else {
                <button
                  type="button"
                  class="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-400"
                  (click)="store.retry()"
                >
                  Try again
                </button>
              }
              <a
                routerLink="/"
                class="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition hover:border-zinc-500"
              >
                Another repository
              </a>
            </div>
          </div>
        </div>
      } @else if (store.phase() !== 'ready') {
        <div class="flex flex-1 flex-col items-center justify-center gap-4 text-zinc-400">
          <svg
            class="size-7 animate-spin text-indigo-300"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle
              class="opacity-20"
              cx="12"
              cy="12"
              r="9"
              stroke="currentColor"
              stroke-width="3"
            />
            <path
              d="M21 12a9 9 0 0 0-9-9"
              stroke="currentColor"
              stroke-width="3"
              stroke-linecap="round"
            />
          </svg>
          <p class="text-sm">
            {{ store.phase() === 'tree' ? 'Loading file tree…' : 'Fetching repository metadata…' }}
          </p>
        </div>
      } @else {
        <div class="flex min-h-0 flex-1">
          @if (!treeCollapsed()) {
            <aside
              class="slim-scrollbar shrink-0 overflow-x-hidden overflow-y-auto border-r border-zinc-800 bg-zinc-950 py-2 pr-1 pl-1"
              [style.width.px]="treeWidth()"
            >
              @if (store.tree().length === 0) {
                <p class="px-3 py-2 text-xs text-zinc-600">This repository has no files.</p>
              } @else {
                <app-file-tree
                  [nodes]="store.tree()"
                  [selectedPath]="
                    insightsMode() ? (store.coChange()?.focus ?? null) : store.selectedPath()
                  "
                  [expanded]="store.expandedDirs()"
                  [metrics]="store.fileMetrics()"
                  (fileSelect)="onTreeFileSelect($event)"
                  (dirToggle)="store.toggleDir($event)"
                />
              }
            </aside>

            <div
              class="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-indigo-400/40"
              [class.bg-indigo-400/40]="dragging()"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize file tree"
              (pointerdown)="onDragStart($event)"
              (pointermove)="onDragMove($event)"
              (pointerup)="onDragEnd()"
              (pointercancel)="onDragEnd()"
              (dblclick)="resetTreeWidth()"
            ></div>
          }

          @if (insightsMode()) {
            <app-insights-view
              class="min-h-0 flex-1"
              [state]="store.coChange()"
              [commitCap]="commitCap"
              (analyze)="store.computeCoChange()"
              (clear)="store.clearCoChange()"
              (focusFile)="store.computeCoChangeFor($event)"
              (openFile)="onInsightsOpenFile($event)"
            />
          } @else {
            <section class="flex min-w-0 flex-1 flex-col bg-zinc-950">
              @if (store.selectedPath()) {
                <div
                  class="flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-xs"
                  [class]="
                    store.viewAt()
                      ? 'border-slate-500/30 bg-slate-500/10 text-slate-200'
                      : 'border-zinc-800 bg-zinc-900/40 text-zinc-400'
                  "
                >
                  <svg
                    class="size-3.5 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 12a9 9 0 1 0 3-6.7" />
                    <path d="M3 4v4h4" />
                    <path d="M12 7v5l3.5 2" />
                  </svg>
                  <span class="min-w-0 truncate">
                    @if (store.viewAt(); as at) {
                      Viewing at
                      @if (store.viewAtCommit(); as commit) {
                        <a
                          class="font-mono underline-offset-2 hover:underline"
                          [href]="commit.htmlUrl"
                          target="_blank"
                          rel="noopener noreferrer"
                          >{{ abbrev(at) }}</a
                        >
                        — {{ commit.summary }}
                        <span class="opacity-60">
                          · {{ commit.authorName }} · {{ when(commit.authoredAt) }}</span
                        >
                      } @else {
                        <span class="font-mono">{{ abbrev(at) }}</span>
                      }
                    } @else {
                      Current version
                      <span class="font-mono opacity-70">· {{ store.ref() }}</span>
                    }
                  </span>
                  <span class="flex-1"></span>
                  <button
                    type="button"
                    class="shrink-0 rounded border px-2 py-0.5 transition"
                    [class]="
                      ownersOpen()
                        ? 'border-indigo-400/40 bg-indigo-500/20 text-indigo-200'
                        : store.viewAt()
                          ? 'border-slate-400/30 hover:bg-slate-400/10'
                          : 'border-zinc-700 hover:bg-white/10'
                    "
                    [attr.aria-pressed]="ownersOpen()"
                    (click)="toggleOwners()"
                    title="Who wrote this file and folder — folded from blame (o)"
                  >
                    Owners
                  </button>
                  <div
                    class="flex shrink-0 overflow-hidden rounded border"
                    [class]="store.viewAt() ? 'border-slate-400/30' : 'border-zinc-700'"
                    role="group"
                    aria-label="View mode"
                  >
                    <button
                      type="button"
                      class="px-2 py-0.5 transition"
                      [class]="
                        !diffMode()
                          ? store.viewAt()
                            ? 'bg-slate-400/25 font-medium'
                            : 'bg-zinc-700/60 font-medium text-zinc-200'
                          : 'hover:bg-white/10'
                      "
                      (click)="setDiffMode(false)"
                    >
                      File
                    </button>
                    <button
                      type="button"
                      class="border-l px-2 py-0.5 transition disabled:cursor-not-allowed disabled:opacity-40"
                      [class]="
                        (store.viewAt() ? 'border-slate-400/30 ' : 'border-zinc-700 ') +
                        (diffMode() ? 'bg-slate-400/25 font-medium' : 'enabled:hover:bg-white/10')
                      "
                      [disabled]="!store.viewAt()"
                      [title]="
                        store.viewAt()
                          ? 'Show what this commit changed in the file'
                          : 'Step to a commit to see its changes'
                      "
                      (click)="setDiffMode(true)"
                    >
                      Changes
                    </button>
                  </div>
                  <button
                    type="button"
                    class="shrink-0 rounded border px-2 py-0.5 transition disabled:cursor-not-allowed disabled:opacity-40"
                    [class]="
                      store.viewAt()
                        ? 'border-slate-400/30 enabled:hover:bg-slate-400/10'
                        : 'border-zinc-700 enabled:hover:bg-white/10'
                    "
                    [disabled]="olderDisabled()"
                    (click)="stepOlder()"
                    title="One commit older (←)"
                  >
                    ← Older
                  </button>
                  <button
                    type="button"
                    class="shrink-0 rounded border px-2 py-0.5 transition disabled:cursor-not-allowed disabled:opacity-40"
                    [class]="
                      store.viewAt()
                        ? 'border-slate-400/30 enabled:hover:bg-slate-400/10'
                        : 'border-zinc-700 enabled:hover:bg-white/10'
                    "
                    [disabled]="newerDisabled()"
                    (click)="stepNewer()"
                    [title]="
                      store.viewAt() ? 'One commit newer (→)' : 'Already at the newest version'
                    "
                  >
                    Newer →
                  </button>
                  @if (store.viewAt()) {
                    <button
                      type="button"
                      class="shrink-0 rounded bg-slate-400/15 px-2 py-0.5 font-medium transition hover:bg-slate-400/25"
                      (click)="goToCommit(null)"
                    >
                      Back to {{ store.ref() }}
                    </button>
                  }
                </div>
              }
              @if (diffMode()) {
                <app-diff-view
                  class="min-h-0 flex-1"
                  [state]="store.selectedDiff()"
                  [path]="store.selectedPath()"
                  [highlightLine]="lineNumber()"
                  [splitMode]="blameOn()"
                  [leftBlame]="leftBlame()"
                  [rightBlame]="rightBlame()"
                  [blameActive]="blameOn()"
                  [historyActive]="historyOpen()"
                  [highlightRange]="activeHighlightRange()"
                  [beforeAvailable]="hunkBeforeAvailable()"
                  (retry)="onDiffRetry()"
                  (before)="onHunkBefore($event)"
                  (trace)="onHunkTrace($event)"
                  (blameToggle)="toggleBlame()"
                  (blameSelect)="onBlameSelect($event)"
                  (historyToggle)="toggleHistory()"
                  (comparisonClear)="onComparisonClear()"
                />
              } @else {
                <app-file-view
                  class="min-h-0 flex-1"
                  [state]="store.selectedFile()"
                  [links]="selectedFileLinks()"
                  [historyActive]="historyOpen()"
                  [blameActive]="blameOn()"
                  [blame]="store.selectedBlame()"
                  [viewKey]="store.viewAt()"
                  [highlightLine]="lineNumber()"
                  [highlightRange]="activeHighlightRange()"
                  (retry)="onFileRetry($event)"
                  (historyToggle)="toggleHistory()"
                  (blameToggle)="toggleBlame()"
                  (blameSelect)="onBlameSelect($event)"
                  (trace)="onFileTrace($event)"
                />
              }
            </section>

            @if (ownersOpen()) {
              <aside class="w-80 shrink-0 border-l border-zinc-800 bg-zinc-950">
                <app-ownership-panel
                  [path]="store.selectedPath()"
                  [fileSummary]="store.selectedOwnership()"
                  [blameUnavailable]="fileBlameUnavailable()"
                  [folderPath]="selectedFolder()"
                  [folder]="store.folderOwnership()"
                  [folderCap]="folderCap"
                  [folderFileCount]="folderFileCount()"
                  (closed)="toggleOwners()"
                  (scanFolder)="onScanFolder()"
                  (scanAll)="onScanAllFolder()"
                  (clearFolder)="store.clearFolderOwnership()"
                />
              </aside>
            }

            @if (historyOpen()) {
              <aside class="w-80 shrink-0 border-l border-zinc-800 bg-zinc-950">
                <app-file-history
                  [path]="store.selectedPath()"
                  [tipRef]="store.ref()"
                  [commits]="store.history()"
                  [status]="store.historyStatus()"
                  [error]="store.historyError()"
                  [hasMore]="store.historyHasMore()"
                  [selectedSha]="store.viewAt()"
                  [renames]="store.selectedRenames()"
                  [trace]="store.lineTrace()"
                  [origins]="store.traceOrigins()"
                  [related]="store.selectedRelated()"
                  (commitSelect)="goToCommit($event)"
                  (relatedSelect)="onFileSelect($event)"
                  (traceSelect)="onTraceSelect($event)"
                  (loadMore)="store.loadMoreHistory()"
                  (loadAll)="store.loadAllHistory()"
                  (retry)="store.retryHistory()"
                  (closed)="toggleHistory()"
                  (findRenames)="onFindRenames()"
                  (candidateSelect)="onCandidateSelect($event)"
                  (candidateDiff)="onCandidateDiff($event)"
                  (traceClear)="store.clearLineTrace()"
                  (traceOlder)="store.extendLineTrace()"
                  (searchOrigins)="store.searchTraceOrigins($event)"
                  (originSelect)="onOriginSelect($event)"
                />
              </aside>
            }
          }
        </div>
      }

      @if (finderOpen() && store.phase() === 'ready') {
        <app-file-finder
          [files]="store.files()"
          (fileSelect)="onFinderSelect($event)"
          (closed)="finderOpen.set(false)"
        />
      }
    </div>
  `,
})
export class ViewerPage {
  protected readonly store = inject(RepoStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly title = inject(Title);
  private readonly localRepos = inject(LocalRepos);

  /** Bound from the route by `withComponentInputBinding`. */
  readonly owner = input.required<string>();
  readonly repo = input.required<string>();
  /** Provider id, bound from the route's data (github/gitlab/local). */
  readonly provider = input('github');
  /** Custom instance origin for self-hosted GitHub/GitLab/Bitbucket Server. */
  readonly host = input<string | undefined>();
  readonly ref = input<string | undefined>();
  readonly path = input<string | undefined>();
  /** Commit sha the selected file is viewed at (time travel). */
  readonly at = input<string | undefined>();
  /** `diff` or `file`; absent falls back to the remembered preference. */
  readonly view = input<string | undefined>();
  /** `0` disables blame annotations; absent/default keeps them on. */
  readonly blame = input<string | undefined>();
  /** 1-based line to highlight and scroll to (file or changes view). */
  readonly line = input<string | undefined>();
  /** Predecessor path to diff the file against (a chosen rename candidate). */
  readonly base = input<string | undefined>();
  /** `1` shows the repository Insights view instead of the file browser. */
  readonly insights = input<string | undefined>();

  protected readonly commitCap = CO_CHANGE_COMMIT_CAP;

  protected readonly treeWidth = signal(restoreTreeWidth());
  protected readonly dragging = signal(false);
  /** Remembered across files and sessions: once opened, History stays open. */
  protected readonly historyOpen = signal(restoreHistoryOpen());
  /** Remembered across sessions: the file tree can be collapsed to widen the view. */
  protected readonly treeCollapsed = signal(restoreTreeCollapsed());
  /** Quick-open file finder overlay (Ctrl/⌘ P). */
  protected readonly finderOpen = signal(false);
  /** Remembered across sessions: the "Owners" authorship panel. */
  protected readonly ownersOpen = signal(restoreOwnersOpen());
  protected readonly folderCap = FOLDER_OWNERSHIP_CAP;
  /** Remembered File/Changes choice; Changes is the default. */
  private readonly viewPref = signal<'file' | 'diff'>(restoreViewMode());
  private dragOrigin: { x: number; width: number } | null = null;
  /** The panel auto-opens only for the first `at` deep link, not every hop. */
  private historyAutoOpened = false;

  protected readonly diffMode = computed(() => {
    if (!this.store.viewAt()) return false;
    const view = this.view();
    return view ? view === 'diff' : this.viewPref() === 'diff';
  });

  /** Blame is available in both views: gutter in File, split in Changes. */
  protected readonly blameOn = computed(() => this.blame() !== '0');

  /** The repository Insights view replaces the file browser when on. */
  protected readonly insightsMode = computed(() => this.insights() === '1');

  /** Parent folder of the selected file ('' for the repository root). */
  protected readonly selectedFolder = computed(() => {
    const path = this.store.selectedPath() ?? '';
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(0, slash) : '';
  });

  /** Reason the file's authorship can't be shown (binary/too-large/error), or null. */
  protected readonly fileBlameUnavailable = computed(() => {
    const blame = this.store.selectedBlame();
    if (blame && (blame.status === 'unavailable' || blame.status === 'error')) {
      return blame.message ?? 'Blame is not available for this file.';
    }
    return null;
  });

  /** Files under the selected file's folder — drives the "scan all" option. */
  protected readonly folderFileCount = computed(() => {
    const folder = this.selectedFolder();
    const prefix = folder ? `${folder}/` : '';
    return this.store.files().filter((f) => f.path.startsWith(prefix)).length;
  });

  /** The `line` query param parsed as a range (`"18"` or `"18-19"`). */
  private readonly urlRange = computed<LineRange | null>(() => parseLineRange(this.line()));

  protected readonly lineNumber = computed<number | null>(() => this.urlRange()?.start ?? null);

  protected readonly activeHighlightRange = computed<LineRange | null>(() => {
    const trace = this.store.lineTrace();
    const path = this.store.selectedPath();
    const at = this.store.viewAt();
    if (trace && trace.status !== 'error' && path && at) {
      const hit = trace.hits.find((entry) => entry.path === path && entry.commit.sha === at);
      if (hit) return hit.range;
      if (trace.path === path && trace.anchorSha === at) return trace.range;
    }
    // No active trace for this version: fall back to the deep-linked range.
    return this.urlRange();
  });

  protected readonly leftBlame = computed(() => {
    const diff = this.store.selectedDiff();
    if (diff?.status !== 'ready' || !diff.baseSha || !diff.basePath) return null;
    return this.store.blameFor(diff.basePath, diff.baseSha);
  });

  protected readonly rightBlame = computed(() => {
    const diff = this.store.selectedDiff();
    if (diff?.status !== 'ready') return this.store.selectedBlame();
    return diff.headPath ? this.store.blameFor(diff.headPath, diff.commit.sha) : null;
  });

  protected readonly selectedFileLinks = computed(() => {
    const path = this.store.selectedPath();
    if (!path) return null;
    return this.store.linksFor(path, this.store.viewAt());
  });

  /** Index of the viewed commit in the loaded history; -1 when unknown. */
  private readonly anchorIndex = computed(() => {
    const at = this.store.viewAt();
    if (!at) return -1;
    return this.store.history().findIndex((c) => c.sha === at);
  });

  private readonly historyReadyForPath = computed(
    () =>
      this.store.historyStatus() === 'ready' &&
      this.store.historyPath() === this.store.selectedPath(),
  );

  protected readonly olderDisabled = computed(() => {
    if (!this.historyReadyForPath()) {
      // Unknown yet — stepping will load the history on demand.
      return !this.store.viewAt() ? false : true;
    }
    const history = this.store.history();
    if (!this.store.viewAt()) return history.length === 0;
    const idx = this.anchorIndex();
    if (idx === -1) return true;
    return idx + 1 >= history.length && !this.store.historyHasMore();
  });

  protected readonly newerDisabled = computed(() => {
    if (!this.store.viewAt()) return true; // already at the newest version
    return this.historyReadyForPath() && this.anchorIndex() === -1;
  });

  /**
   * Whether a hunk's "◂ Before" can lead anywhere: false once the loaded
   * history shows the viewed commit created the file (nothing earlier).
   */
  protected readonly hunkBeforeAvailable = computed(() => {
    const diff = this.store.selectedDiff();
    if (diff?.status === 'ready') return !!diff.basePath;
    if (!this.store.viewAt()) return false;
    if (!this.historyReadyForPath()) return true; // unknown yet — the handler resolves it
    const idx = this.anchorIndex();
    if (idx === -1) return false;
    return idx + 1 < this.store.history().length || this.store.historyHasMore();
  });

  protected readonly errorTitle = computed(() => {
    switch (this.store.error()?.kind) {
      case 'rate-limited':
        return 'GitHub rate limit reached';
      case 'not-found':
        return 'Repository not found';
      case 'invalid-ref':
        return 'Ref not found';
      case 'empty-repo':
        return 'Empty repository';
      case 'network':
        return 'Network problem';
      default:
        return 'Something went wrong';
    }
  });

  constructor() {
    effect(() => {
      const provider = this.provider() || 'github';
      const owner = this.owner();
      const repo = this.repo();
      const host = this.host() || undefined;
      const ref = this.ref() || undefined;
      untracked(
        () => void this.store.loadRepo({ provider, owner, repo, ...(host ? { host } : {}) }, ref),
      );
    });

    effect(() => {
      const phase = this.store.phase();
      const path = this.path() || null;
      const at = this.at() || null;
      untracked(() => {
        if (phase !== 'ready') return;
        if (path) {
          void this.store.openFile(path, at);
          if (at && !this.historyAutoOpened) {
            this.historyAutoOpened = true;
            this.historyOpen.set(true);
          }
        } else {
          this.store.clearSelection();
        }
      });
    });

    // History powers the steppers and blame, so load it for every selection.
    effect(() => {
      const phase = this.store.phase();
      const path = this.store.selectedPath();
      untracked(() => {
        if (phase === 'ready' && path) void this.store.loadHistory(path);
      });
    });

    effect(() => {
      const phase = this.store.phase();
      const diff = this.diffMode();
      const path = this.path() || null;
      const at = this.at() || null;
      const base = this.base() || null;
      untracked(() => {
        // `base` only applies to the changes view; clear it otherwise.
        const against = diff ? base : null;
        this.store.setCompareBase(against);
        if (phase === 'ready' && diff && path && at) void this.store.loadDiff(path, at, against);
      });
    });

    effect(() => {
      const phase = this.store.phase();
      const blame = this.blameOn();
      const diff = this.diffMode();
      const path = this.path() || null;
      const at = this.at() || null;
      const selectedDiff = this.store.selectedDiff();
      // Depend on the loaded history: when more commits are paged in, lines
      // attributed to "older" (beyond the loaded pages) can finally be traced
      // to the commit that introduced them, so re-run blame.
      void this.store.history();
      const basePath = diff && selectedDiff?.status === 'ready' ? selectedDiff.basePath : null;
      const baseSha = diff && selectedDiff?.status === 'ready' ? selectedDiff.baseSha : null;
      const headPath = diff && selectedDiff?.status === 'ready' ? selectedDiff.headPath : path;
      untracked(() => {
        if (phase !== 'ready' || !blame || !path) return;
        if (headPath) void this.store.loadBlame(headPath, at);
        // The split changes view also annotates the version before.
        if (diff && basePath && baseSha) void this.store.loadBlame(basePath, baseSha);
      });
    });

    effect(() => {
      const fullName = this.store.metadata()?.fullName;
      if (fullName) this.title.setTitle(`${fullName} · Time Tracer`);
    });

    // The Owners panel folds blame, so make sure blame is computed for the
    // selected file even when its gutter display is turned off — and re-fold
    // it (via re-blame) as more history is paged in.
    effect(() => {
      const open = this.ownersOpen();
      const phase = this.store.phase();
      const path = this.path() || null;
      const at = this.at() || null;
      void this.store.history();
      untracked(() => {
        if (open && phase === 'ready' && path) void this.store.loadBlame(path, at);
      });
    });

    // A folder ownership result belongs to one folder; drop it (cancelling any
    // scan) once the selection moves to a different folder.
    effect(() => {
      const folder = this.selectedFolder();
      untracked(() => {
        const result = this.store.folderOwnership();
        if (result && result.path !== folder) this.store.clearFolderOwnership();
      });
    });

    // Opening a repository always reveals the file tree — it is how you start
    // navigating a new codebase. A deliberate collapse still sticks while you
    // browse that same repo; only loading another one re-reveals it.
    effect(() => {
      const slug = this.store.slug();
      untracked(() => {
        if (slug && this.treeCollapsed()) {
          this.treeCollapsed.set(false);
          persistTreeCollapsed(false);
        }
      });
    });
  }

  /**
   * App-wide keyboard shortcuts (the viewer is otherwise mouse-driven):
   * Ctrl/⌘ P quick-open · ←/→ older/newer commit · b blame · h history ·
   * o owners · t file tree · Esc closes the side panels. Single-key shortcuts
   * are skipped while a field is focused or the finder overlay is open, and
   * never fire with a modifier held (so they don't shadow browser keys).
   */
  protected onGlobalKeydown(event: KeyboardEvent): void {
    if (this.store.phase() !== 'ready') return;

    // Ctrl/⌘ P opens the finder, overriding the browser print dialog — this one
    // works even while a field is focused.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      this.finderOpen.set(true);
      return;
    }

    // Leave alone: keys another handler already consumed (e.g. the finder's
    // Esc/arrows), keys typed into a field, anything while the finder is open,
    // and modifier combos.
    if (event.defaultPrevented || this.finderOpen() || isEditableTarget(event.target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        void this.stepOlder();
        break;
      case 'ArrowRight':
        event.preventDefault();
        this.stepNewer();
        break;
      case 'b':
      case 'B':
        event.preventDefault();
        this.toggleBlame();
        break;
      case 'h':
      case 'H':
        event.preventDefault();
        this.toggleHistory();
        break;
      case 'o':
      case 'O':
        event.preventDefault();
        this.toggleOwners();
        break;
      case 't':
      case 'T':
        event.preventDefault();
        this.toggleTree();
        break;
      case 'Escape':
        this.closePanels();
        break;
    }
  }

  /** Esc: dismiss the open side panels (owners, then history). */
  private closePanels(): void {
    if (this.ownersOpen()) this.toggleOwners();
    if (this.historyOpen()) this.toggleHistory();
  }

  protected openFinder(): void {
    this.finderOpen.set(true);
  }

  /** Shows or hides the repository Insights view (deep-linked via `?insights=1`). */
  protected toggleInsights(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { insights: this.insightsMode() ? null : '1' },
      queryParamsHandling: 'merge',
    });
  }

  /** A file was picked in Insights: open it and leave the Insights view. */
  protected onInsightsOpenFile(path: string): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { path, insights: null, at: null, view: null, line: null, base: null },
      queryParamsHandling: 'merge',
    });
  }

  /** A file was picked in the finder: open it and dismiss the overlay. */
  protected onFinderSelect(path: string): void {
    this.finderOpen.set(false);
    this.onFileSelect(path);
  }

  /**
   * Tree clicks focus the co-change analysis while Insights is open, and open
   * the file otherwise.
   */
  protected onTreeFileSelect(path: string): void {
    if (this.insightsMode()) {
      void this.store.computeCoChangeFor(path);
      return;
    }
    this.onFileSelect(path);
  }

  protected onFileSelect(path: string): void {
    // Switching files always returns to the snapshot tip: `at`, `view` and
    // `line` belong to the previous file's timeline. Blame mode is sticky.
    // Opening a file also leaves the Insights view.
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { path, at: null, view: null, line: null, base: null, insights: null },
      queryParamsHandling: 'merge',
    });
  }

  /**
   * Navigates the selected file to `sha` (or back to the tip when null),
   * applying the remembered File/Changes preference for commit views unless
   * a target view/line is given (line-targeted jumps pick their own view).
   */
  protected goToCommit(
    sha: string | null,
    options?: { view?: 'file' | 'diff'; line?: number; blame?: '1' },
  ): void {
    const queryParams: Record<string, string | null> = {
      at: sha,
      view: sha ? (options?.view ?? this.viewPref()) : null,
      line: options?.line ? String(options.line) : null,
      // A comparison base belongs to one commit's changes; stepping drops it.
      base: null,
    };
    if (options?.blame) queryParams['blame'] = options.blame;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams,
      queryParamsHandling: 'merge',
    });
  }

  /** A blame annotation was clicked: show that commit's diff at the line. */
  protected onBlameSelect(event: { sha: string; line: number }): void {
    this.goToCommit(event.sha, { view: 'diff', line: event.line });
  }

  /** A filtered trace commit was clicked: open it at the matched range. */
  protected onTraceSelect(hit: LineTraceHit): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        path: hit.path,
        at: hit.commit.sha,
        view: 'diff',
        line: formatLineRange(hit.range),
        base: null,
      },
      queryParamsHandling: 'merge',
    });
  }

  /**
   * "◂ Before" on a hunk: annotate the previous version at the hunk's old
   * position — one recursive step back in time. The target is the previous
   * entry in the file's history rather than the commit's raw parent: the
   * parent often never touched the file (blame could not anchor there) and,
   * for files created by this commit, does not contain it at all. When
   * nothing earlier exists, fall back to this version annotated instead of
   * navigating into a void.
   */
  protected async onHunkBefore(target: { oldStart: number; newStart: number }): Promise<void> {
    const path = this.store.selectedPath();
    const at = this.store.viewAt();
    if (!path || !at) return;
    const diff = this.store.selectedDiff();
    if (diff?.status === 'ready' && diff.baseSha && diff.basePath && diff.basePath !== path) {
      const anchor = await this.store.lastTouch(diff.basePath, diff.baseSha);
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: {
          path: diff.basePath,
          at: anchor?.sha ?? diff.baseSha,
          view: 'file',
          blame: null,
          line: String(Math.max(1, target.oldStart)),
          base: null,
        },
        queryParamsHandling: 'merge',
      });
      return;
    }
    if (!this.historyReadyForPath()) await this.store.loadHistory(path);
    let history = this.store.history();
    let idx = history.findIndex((c) => c.sha === at);
    if (idx !== -1 && idx + 1 >= history.length && this.store.historyHasMore()) {
      await this.store.loadMoreHistory();
      history = this.store.history();
      idx = history.findIndex((c) => c.sha === at);
    }
    const previous = idx === -1 ? null : (history[idx + 1] ?? null);
    if (!previous) {
      this.goToCommit(at, { view: 'file', blame: '1', line: Math.max(1, target.newStart) });
      return;
    }
    this.goToCommit(previous.sha, {
      view: 'file',
      blame: '1',
      line: Math.max(1, target.oldStart),
    });
  }

  /** Trace a new-side line range, anchored at the viewed commit. */
  protected onHunkTrace(range: LineRange): void {
    const path = this.store.selectedPath();
    const at = this.store.viewAt();
    if (!path || !at) return;
    if (!this.historyOpen()) this.toggleHistory();
    void this.store.startLineTrace(path, at, range);
    // Deep-link the traced range so reloads and shared links keep it.
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { line: formatLineRange(range) },
      queryParamsHandling: 'merge',
    });
  }

  /**
   * Trace a line range selected in the file view. The current version has no
   * commit to anchor against, so the range is pinned to the most recent commit
   * that touched the file — its content (and line numbers) match the tip — and
   * the journey can begin straight from the file you are reading.
   */
  protected async onFileTrace(range: LineRange): Promise<void> {
    const path = this.store.selectedPath();
    if (!path) return;
    let anchor = this.store.viewAt();
    if (!anchor) {
      if (!this.historyReadyForPath()) await this.store.loadHistory(path);
      anchor = this.store.history()[0]?.sha ?? null;
      if (!anchor) return;
    }
    if (!this.historyOpen()) this.toggleHistory();
    void this.store.startLineTrace(path, anchor, range);
    // Deep-link the traced range so reloads and shared links keep it.
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { line: formatLineRange(range) },
      queryParamsHandling: 'merge',
    });
  }

  protected onFindRenames(): void {
    const path = this.store.selectedPath();
    if (path) void this.store.loadRenameCandidates(path);
  }

  /**
   * Continues the journey in a rename candidate: anchors at the last commit
   * that touched the candidate before the rename point, so history, blame
   * and the steppers all keep working in the predecessor's own timeline.
   */
  protected async onCandidateSelect(candidate: RenameCandidate): Promise<void> {
    const renames = this.store.selectedRenames();
    if (renames?.status !== 'ready') return;
    const anchor = await this.store.lastTouch(candidate.path, renames.parentSha);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        path: candidate.path,
        at: anchor?.sha ?? renames.parentSha,
        view: this.viewPref(),
        blame: null,
        line: null,
        base: null,
      },
      queryParamsHandling: 'merge',
    });
  }

  /**
   * "Diff" on a rename candidate: compare the file at its creation (the oldest
   * commit of its recorded history) against the chosen predecessor, by setting
   * the `base` query param. The candidate lives at the creating commit's first
   * parent, so it becomes the diff's old side.
   */
  protected onCandidateDiff(candidate: RenameCandidate): void {
    const renames = this.store.selectedRenames();
    if (renames?.status !== 'ready') return;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        at: renames.endCommit.sha,
        view: 'diff',
        base: candidate.path,
        blame: null,
        line: null,
      },
      queryParamsHandling: 'merge',
    });
  }

  /** Drops the predecessor comparison, back to the commit's own changes. */
  protected onComparisonClear(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { base: null },
      queryParamsHandling: 'merge',
    });
  }

  /**
   * A hunk-origin candidate was picked: open that file as it was just
   * before the introducing commit, scrolled to the matched line. Anchored
   * at the candidate's own last touch (like rename candidates) so history,
   * blame and the steppers keep working in the source file's timeline.
   */
  protected async onOriginSelect(candidate: HunkOriginCandidate): Promise<void> {
    // Highlight the whole block at the match, sized from the traced range.
    const origin = this.store.lineTrace()?.origin;
    const span = origin ? origin.range.end - origin.range.start : 0;
    const range: LineRange = { start: candidate.line, end: candidate.line + span };
    const anchor = await this.store.lastTouch(candidate.path, candidate.parentSha);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        path: candidate.path,
        at: anchor?.sha ?? candidate.parentSha,
        view: 'file',
        line: formatLineRange(range),
        base: null,
      },
      queryParamsHandling: 'merge',
    });
  }

  /**
   * Switches the content pane between file and changes mode (URL-driven)
   * and remembers the choice for future commit views.
   */
  protected setDiffMode(enabled: boolean): void {
    if (!this.store.viewAt()) return; // no commit selected — nothing to switch
    const mode = enabled ? 'diff' : 'file';
    this.viewPref.set(mode);
    persistViewMode(mode);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { view: mode },
      queryParamsHandling: 'merge',
    });
  }

  /** Steps to the next-older commit, loading history pages on demand. */
  protected async stepOlder(): Promise<void> {
    const path = this.store.selectedPath();
    if (!path) return;
    if (!this.historyReadyForPath()) await this.store.loadHistory(path);
    const history = this.store.history();
    const at = this.store.viewAt();
    if (!at) {
      if (history.length > 0) this.goToCommit(history[0].sha);
      return;
    }
    const idx = history.findIndex((c) => c.sha === at);
    if (idx === -1) return;
    if (idx + 1 < history.length) {
      this.goToCommit(history[idx + 1].sha);
      return;
    }
    if (this.store.historyHasMore()) {
      await this.store.loadMoreHistory();
      const extended = this.store.history();
      if (idx + 1 < extended.length) this.goToCommit(extended[idx + 1].sha);
    }
  }

  /** Steps to the next-newer commit, ending at the tip. */
  protected stepNewer(): void {
    const at = this.store.viewAt();
    if (!at) return;
    const idx = this.anchorIndex();
    if (idx === -1) return;
    this.goToCommit(idx === 0 ? null : this.store.history()[idx - 1].sha);
  }

  /** Re-grants read permission to a persisted local folder (user gesture). */
  protected async reconnectLocal(): Promise<void> {
    const name = this.repo();
    try {
      const ok = await this.localRepos.reconnect(name);
      if (ok) {
        this.store.retry();
      } else if (!(await this.localRepos.hasStoredHandle(name))) {
        void this.router.navigate(['/']);
      }
    } catch {
      void this.router.navigate(['/']);
    }
  }

  protected toggleHistory(): void {
    this.historyOpen.update((open) => !open);
    try {
      localStorage.setItem(HISTORY_OPEN_KEY, this.historyOpen() ? '1' : '0');
    } catch {
      // Best-effort only.
    }
  }

  protected toggleOwners(): void {
    this.ownersOpen.update((open) => !open);
    try {
      localStorage.setItem(OWNERS_OPEN_KEY, this.ownersOpen() ? '1' : '0');
    } catch {
      // Best-effort only.
    }
  }

  /** Blames the selected file's folder (capped) and aggregates its authorship. */
  protected onScanFolder(): void {
    void this.store.computeFolderOwnership(this.selectedFolder());
  }

  /** Blames every file under the folder, no cap — the "load all" option. */
  protected onScanAllFolder(): void {
    void this.store.computeFolderOwnership(this.selectedFolder(), { all: true });
  }

  /** Hides or restores the file tree (the resized width is preserved). */
  protected toggleTree(): void {
    this.treeCollapsed.update((collapsed) => !collapsed);
    persistTreeCollapsed(this.treeCollapsed());
  }

  protected toggleBlame(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { blame: this.blameOn() ? '0' : null },
      queryParamsHandling: 'merge',
    });
  }

  protected onFileRetry(path: string): void {
    void this.store.openFile(path, this.store.viewAt());
  }

  protected onDiffRetry(): void {
    const path = this.store.selectedPath();
    const at = this.store.viewAt();
    if (path && at) void this.store.loadDiff(path, at);
  }

  protected abbrev(sha: string): string {
    return shortSha(sha);
  }

  protected when(iso: string): string {
    return relativeTime(iso);
  }

  protected onDragStart(event: PointerEvent): void {
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.dragOrigin = { x: event.clientX, width: this.treeWidth() };
    this.dragging.set(true);
  }

  protected onDragMove(event: PointerEvent): void {
    if (!this.dragOrigin) return;
    const width = this.dragOrigin.width + event.clientX - this.dragOrigin.x;
    this.treeWidth.set(Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, width)));
  }

  protected onDragEnd(): void {
    if (!this.dragOrigin) return;
    this.dragOrigin = null;
    this.dragging.set(false);
    persistTreeWidth(this.treeWidth());
  }

  protected resetTreeWidth(): void {
    this.treeWidth.set(TREE_WIDTH_DEFAULT);
    persistTreeWidth(TREE_WIDTH_DEFAULT);
  }
}

/** Whether the keydown target is a text field, so shortcuts shouldn't fire. */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  const tag = el?.tagName?.toLowerCase();
  return (
    tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable === true
  );
}

function restoreTreeWidth(): number {
  try {
    const stored = Number(localStorage.getItem(TREE_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= TREE_WIDTH_MIN && stored <= TREE_WIDTH_MAX) {
      return stored;
    }
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  return TREE_WIDTH_DEFAULT;
}

function persistTreeWidth(width: number): void {
  try {
    localStorage.setItem(TREE_WIDTH_KEY, String(width));
  } catch {
    // Best-effort only.
  }
}

function restoreViewMode(): 'file' | 'diff' {
  try {
    const stored = localStorage.getItem(VIEW_MODE_KEY);
    if (stored === 'file' || stored === 'diff') return stored;
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  return 'diff';
}

function persistViewMode(mode: 'file' | 'diff'): void {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // Best-effort only.
  }
}

function restoreHistoryOpen(): boolean {
  try {
    return localStorage.getItem(HISTORY_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function restoreTreeCollapsed(): boolean {
  try {
    return localStorage.getItem(TREE_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function persistTreeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(TREE_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Best-effort only.
  }
}

function restoreOwnersOpen(): boolean {
  try {
    return localStorage.getItem(OWNERS_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}
