import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { CommitInfo } from '../../core/models';
import { BranchGraphState, BranchesState } from '../../core/store/repo-store';
import {
  BranchGraph,
  CollapsedNode,
  CommitNode,
  layoutBranchGraph,
} from '../../core/util/branch-graph';
import { relativeTime, shortSha } from '../../core/util/relative-time';
import { CopyButton } from './copy-button';

/** Horizontal space per commit column. */
const COL_W = 32;
/** Vertical space per branch lane. */
const LANE_H = 44;
const PAD_L = 20;
/** Right padding leaves room for the newest commits' branch labels. */
const PAD_R = 120;
const PAD_T = 30;
const PAD_B = 16;
/** Commit dot radius. */
const DOT_R = 5;

/** Categorical lane colours (same accents the Insights team graph uses). */
const LANE_COLORS = [
  '#818cf8',
  '#34d399',
  '#fbbf24',
  '#f472b6',
  '#60a5fa',
  '#a78bfa',
  '#fb923c',
  '#22d3ee',
];

interface DotView {
  readonly sha: string;
  readonly x: number;
  readonly y: number;
  readonly color: string;
  /** Merges and branch tips render filled; plain commits as rings. */
  readonly filled: boolean;
  readonly clipped: boolean;
  readonly labels: readonly LabelChip[];
  readonly title: string;
}

interface LabelChip {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

interface PillView {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly color: string;
  readonly count: number;
  readonly title: string;
}

interface EdgeView {
  readonly path: string;
  readonly color: string;
}

interface LaneView {
  readonly y: number;
  readonly stripeY: number;
  readonly label: string | null;
  readonly color: string;
  readonly even: boolean;
}

interface GraphView {
  readonly width: number;
  readonly height: number;
  readonly lanes: readonly LaneView[];
  readonly edges: readonly EdgeView[];
  readonly dots: readonly DotView[];
  readonly pills: readonly PillView[];
  readonly commitCount: number;
  readonly laneCount: number;
}

/**
 * The Branch Explorer — a horizontal commit graph in the spirit of gmaster's
 * branch explorer. Every branch is a lane, commits flow left → right, merged
 * side branches get their own unnamed lanes, merges curve back into their
 * target, and long linear runs collapse into "N" pills that expand on click.
 * Clicking a commit opens a detail bar with time-travel into the tree at that
 * commit; further branches can be added to the graph one request at a time.
 */
@Component({
  selector: 'app-branch-explorer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CopyButton],
  host: {
    class: 'flex min-h-0 flex-col bg-zinc-950',
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'onEscape($event)',
  },
  template: `
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2">
      <svg
        class="size-4 text-indigo-300"
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
      <h2 class="text-sm font-semibold text-zinc-100">Branch Explorer</h2>
      @if (view(); as v) {
        <span class="text-xs text-zinc-500">
          {{ v.commitCount }} commits · {{ v.laneCount }} {{ v.laneCount === 1 ? 'lane' : 'lanes' }}
        </span>
      }
      @if (message(); as note) {
        <span
          class="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-300"
          [title]="note"
        >
          partial graph
        </span>
      }

      <span class="flex-1"></span>

      @if (hasExpanded()) {
        <button
          type="button"
          class="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
          (click)="collapseRuns()"
          title="Fold the expanded runs back into pills"
        >
          Re-collapse runs
        </button>
      }
      @if (hasMore()) {
        <button
          type="button"
          class="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
          [disabled]="loadingMore()"
          (click)="loadMore.emit()"
          title="Fetch one more page of older commits for every loaded branch"
        >
          {{ loadingMore() ? 'Loading…' : '← Older commits' }}
        </button>
      }
      <div class="relative">
        <button
          #addButton
          type="button"
          class="flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
          [disabled]="loadingMore()"
          (click)="toggleAdd()"
          aria-haspopup="listbox"
          [attr.aria-expanded]="addOpen()"
          title="Add another branch to the graph (one request)"
        >
          + Add branch
        </button>
        @if (addOpen()) {
          <div
            class="absolute top-full right-0 z-50 mt-1 flex w-72 flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
          >
            @if (branches()?.status === 'ready') {
              <input
                #filterInput
                type="text"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                placeholder="Find a branch…"
                aria-label="Branch name"
                class="h-9 border-b border-zinc-800 bg-transparent px-3 text-xs text-zinc-100 outline-none placeholder:text-zinc-600"
                [value]="filter()"
                (input)="onFilterInput($event)"
              />
              @if (addableBranches().length === 0) {
                <p class="px-3 py-4 text-center text-xs text-zinc-500">
                  {{ filter().trim() ? 'No branches match.' : 'Every branch is already loaded.' }}
                </p>
              } @else {
                <ul
                  role="listbox"
                  aria-label="Branches to add"
                  class="slim-scrollbar max-h-72 min-h-0 overflow-y-auto py-1"
                >
                  @for (name of addableBranches(); track name) {
                    <li>
                      <button
                        type="button"
                        role="option"
                        aria-selected="false"
                        class="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs text-zinc-200 transition-colors hover:bg-white/5"
                        (click)="chooseBranch(name)"
                      >
                        <span class="min-w-0 flex-1 truncate">{{ name }}</span>
                        @if (name === defaultBranch()) {
                          <span
                            class="shrink-0 rounded-full border border-zinc-700 px-1.5 py-px text-[10px] text-zinc-500"
                          >
                            default
                          </span>
                        }
                      </button>
                    </li>
                  }
                </ul>
              }
            } @else if (branches()?.status === 'error') {
              <div class="px-3 py-3 text-xs">
                <p class="text-rose-300">{{ branchesError() }}</p>
                <button
                  type="button"
                  class="mt-2 rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
                  (click)="loadBranches.emit()"
                >
                  Try again
                </button>
              </div>
            } @else {
              <p class="px-3 py-3 text-xs text-zinc-500">Loading branches…</p>
            }
          </div>
        }
      </div>
    </div>

    @if (!state() || state()?.status === 'loading') {
      <div class="flex flex-1 flex-col items-center justify-center gap-3 text-zinc-400">
        <svg
          class="size-6 animate-spin text-indigo-300"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle class="opacity-20" cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" />
          <path
            d="M21 12a9 9 0 0 0-9-9"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
          />
        </svg>
        <p class="text-sm">Loading the commit graph…</p>
      </div>
    } @else if (state()?.status === 'error') {
      <div class="flex flex-1 items-center justify-center px-6">
        <div
          class="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center"
        >
          <h3 class="text-base font-semibold text-zinc-100">The graph could not be loaded</h3>
          <p class="mt-2 text-sm leading-6 text-zinc-400">{{ errorMessage() }}</p>
          <button
            type="button"
            class="mt-5 rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-400"
            (click)="load.emit()"
          >
            Try again
          </button>
        </div>
      </div>
    } @else if (view(); as v) {
      @if (v.commitCount === 0) {
        <div class="flex flex-1 items-center justify-center">
          <p class="text-sm text-zinc-500">No commits found on this ref.</p>
        </div>
      } @else {
        <div #scroller class="slim-scrollbar min-h-0 flex-1 overflow-auto" (scroll)="onScroll()">
          <div class="relative" [style.width.px]="v.width" [style.height.px]="v.height">
            <svg
              class="absolute inset-0"
              [attr.width]="v.width"
              [attr.height]="v.height"
              [attr.viewBox]="'0 0 ' + v.width + ' ' + v.height"
              role="img"
              aria-label="Commit graph: branches as lanes, commits left to right"
            >
              <!-- Lane zebra stripes -->
              @for (lane of v.lanes; track lane.y) {
                @if (lane.even) {
                  <rect
                    [attr.x]="0"
                    [attr.y]="lane.stripeY"
                    [attr.width]="v.width"
                    [attr.height]="laneHeight"
                    fill="#ffffff"
                    fill-opacity="0.025"
                  />
                }
              }
              <!-- Edges under the nodes -->
              @for (edge of v.edges; track edge.path) {
                <path
                  [attr.d]="edge.path"
                  [attr.stroke]="edge.color"
                  stroke-width="2"
                  stroke-opacity="0.75"
                  fill="none"
                />
              }
              <!-- Collapsed runs -->
              @for (pill of v.pills; track pill.id) {
                <g
                  class="cursor-pointer"
                  role="button"
                  tabindex="0"
                  [attr.aria-label]="pill.title"
                  (click)="expandPill(pill.id)"
                  (keydown.enter)="expandPill(pill.id)"
                >
                  <title>{{ pill.title }}</title>
                  <rect
                    [attr.x]="pill.x - pill.width / 2"
                    [attr.y]="pill.y - 8"
                    [attr.width]="pill.width"
                    height="16"
                    rx="8"
                    fill="var(--color-zinc-900)"
                    [attr.stroke]="pill.color"
                    stroke-dasharray="3 3"
                    class="transition hover:fill-zinc-800"
                  />
                  <text
                    [attr.x]="pill.x"
                    [attr.y]="pill.y + 3"
                    text-anchor="middle"
                    font-size="9"
                    [attr.fill]="pill.color"
                    class="pointer-events-none select-none"
                  >
                    {{ pill.count }}
                  </text>
                </g>
              }
              <!-- Commit dots -->
              @for (dot of v.dots; track dot.sha) {
                <g
                  class="cursor-pointer"
                  role="button"
                  tabindex="0"
                  [attr.aria-label]="dot.title"
                  (click)="select(dot.sha)"
                  (keydown.enter)="select(dot.sha)"
                >
                  <title>{{ dot.title }}</title>
                  @if (dot.clipped) {
                    <line
                      [attr.x1]="dot.x - colWidth * 0.7"
                      [attr.y1]="dot.y"
                      [attr.x2]="dot.x - dotRadius - 2"
                      [attr.y2]="dot.y"
                      stroke="var(--color-zinc-600)"
                      stroke-width="2"
                      stroke-dasharray="2 3"
                    />
                  }
                  @if (dot.sha === selectedSha()) {
                    <circle
                      [attr.cx]="dot.x"
                      [attr.cy]="dot.y"
                      [attr.r]="dotRadius + 4"
                      fill="none"
                      stroke="#818cf8"
                      stroke-width="2"
                    />
                  }
                  <circle
                    [attr.cx]="dot.x"
                    [attr.cy]="dot.y"
                    [attr.r]="dotRadius"
                    [attr.fill]="dot.filled ? dot.color : 'var(--color-zinc-950)'"
                    [attr.stroke]="dot.color"
                    stroke-width="2"
                  />
                </g>
              }
              <!-- Branch name chips at their tips -->
              @for (dot of v.dots; track dot.sha) {
                @for (chip of dot.labels; track chip.text) {
                  <g class="pointer-events-none">
                    <rect
                      [attr.x]="chip.x - chip.width / 2"
                      [attr.y]="chip.y - 9"
                      [attr.width]="chip.width"
                      height="14"
                      rx="7"
                      [attr.fill]="dot.color"
                      fill-opacity="0.15"
                      [attr.stroke]="dot.color"
                      stroke-opacity="0.6"
                    />
                    <text
                      [attr.x]="chip.x"
                      [attr.y]="chip.y + 1.5"
                      text-anchor="middle"
                      font-size="9"
                      font-family="ui-monospace, monospace"
                      [attr.fill]="dot.color"
                      class="select-none"
                    >
                      {{ chip.text }}
                    </text>
                  </g>
                }
              }
            </svg>
            <!-- Lane labels, pinned while scrolling horizontally -->
            <div class="pointer-events-none sticky left-0 z-10 h-0 w-0 overflow-visible">
              @for (lane of v.lanes; track lane.y) {
                <div
                  class="absolute left-1.5 flex max-w-56 items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-950/80 px-2 py-0.5 backdrop-blur-sm"
                  [style.top.px]="lane.y - 11"
                >
                  <span
                    class="size-2 shrink-0 rounded-full"
                    [style.background]="lane.color"
                    aria-hidden="true"
                  ></span>
                  @if (lane.label) {
                    <span class="truncate font-mono text-[10px] text-zinc-300">{{
                      lane.label
                    }}</span>
                  } @else {
                    <span class="truncate text-[10px] text-zinc-500 italic">merged branch</span>
                  }
                </div>
              }
            </div>
          </div>
        </div>

        @if (selected(); as commit) {
          <div
            class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-800 bg-zinc-900/60 px-4 py-2 text-xs text-zinc-300"
          >
            <span class="font-mono text-indigo-300">{{ abbrev(commit.sha) }}</span>
            <app-copy-button
              [value]="commit.sha"
              label="Copy sha"
              title="Copy the full sha"
              buttonClass="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
            />
            <span class="min-w-0 flex-1 truncate" [title]="commit.message">{{
              commit.summary
            }}</span>
            <span class="shrink-0 text-zinc-500">
              {{ commit.authorName }} · {{ when(commit.authoredAt) }}
            </span>
            @if (commit.parentShas.length > 0) {
              <span class="flex shrink-0 items-center gap-1 text-zinc-500">
                {{ commit.parentShas.length === 1 ? 'parent' : 'parents' }}
                @for (parent of commit.parentShas; track parent) {
                  @if (isLoaded(parent)) {
                    <button
                      type="button"
                      class="rounded border border-zinc-700 px-1 py-px font-mono text-[11px] text-zinc-300 transition hover:border-indigo-400/60 hover:text-indigo-200"
                      (click)="select(parent)"
                    >
                      {{ abbrev(parent) }}
                    </button>
                  } @else {
                    <span
                      class="rounded border border-zinc-800 px-1 py-px font-mono text-[11px] text-zinc-600"
                      title="Not loaded — fetch older commits to reach it"
                      >{{ abbrev(parent) }}</span
                    >
                  }
                }
              </span>
            }
            <button
              type="button"
              class="shrink-0 rounded bg-indigo-500 px-2 py-0.5 font-medium text-white transition hover:bg-indigo-400"
              (click)="browse.emit(commit.sha)"
              title="Open the file tree as it was at this commit"
            >
              Browse this commit
            </button>
            <a
              class="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
              [href]="commit.htmlUrl"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open ↗
            </a>
            <button
              type="button"
              class="shrink-0 rounded p-1 text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200"
              (click)="selectedSha.set(null)"
              aria-label="Close commit details"
            >
              ✕
            </button>
          </div>
        }
      }
    }
  `,
})
export class BranchExplorer {
  /** Graph state from the store; null until the first load kicks off. */
  readonly state = input<BranchGraphState | null>(null);
  /** The repository's branch list, backing the "Add branch" dropdown. */
  readonly branches = input<BranchesState | null>(null);
  readonly defaultBranch = input<string | null>(null);

  /** Retry after an error. */
  readonly load = output<void>();
  /** Fetch one more page of older commits for every loaded branch. */
  readonly loadMore = output<void>();
  /** Add a branch to the graph. */
  readonly addBranch = output<string>();
  /** The add-branch dropdown was opened — load the branch list. */
  readonly loadBranches = output<void>();
  /** "Browse this commit" — open the file tree at that sha. */
  readonly browse = output<string>();

  protected readonly colWidth = COL_W;
  protected readonly laneHeight = LANE_H;
  protected readonly dotRadius = DOT_R;

  /** Collapsed runs the user expanded (ids per {@link CollapsedNode.id}). */
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());
  protected readonly selectedSha = signal<string | null>(null);
  protected readonly addOpen = signal(false);
  protected readonly filter = signal('');

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly scroller = viewChild<ElementRef<HTMLDivElement>>('scroller');
  private readonly filterInput = viewChild<ElementRef<HTMLInputElement>>('filterInput');
  /** Scroll anchor: distance from the right edge, restored across relayouts. */
  private fromRight = 0;

  private readonly readyState = computed(() => {
    const state = this.state();
    return state && (state.status === 'ready' || state.status === 'loading-more') ? state : null;
  });

  protected readonly loadingMore = computed(() => this.state()?.status === 'loading-more');
  protected readonly hasMore = computed(() => this.readyState()?.hasMore ?? false);
  protected readonly message = computed(() => this.readyState()?.message ?? null);
  protected readonly hasExpanded = computed(() => this.expanded().size > 0);

  protected readonly errorMessage = computed(() => {
    const state = this.state();
    return state?.status === 'error' ? state.message : '';
  });

  protected readonly branchesError = computed(() => {
    const state = this.branches();
    return state?.status === 'error' ? state.message : '';
  });

  /** Commit metadata by sha, for the detail bar and tooltips. */
  private readonly commitsBySha = computed<ReadonlyMap<string, CommitInfo>>(() => {
    const state = this.readyState();
    if (!state) return new Map();
    const map = new Map<string, CommitInfo>();
    for (const commit of state.commits) if (!map.has(commit.sha)) map.set(commit.sha, commit);
    return map;
  });

  private readonly graph = computed<BranchGraph | null>(() => {
    const state = this.readyState();
    if (!state) return null;
    return layoutBranchGraph(state.commits, state.heads, { expanded: this.expanded() });
  });

  /** Everything the SVG needs, precomputed so the template stays declarative. */
  protected readonly view = computed<GraphView | null>(() => {
    const graph = this.graph();
    if (!graph) return null;
    const commits = this.commitsBySha();
    const x = (column: number): number => PAD_L + column * COL_W + COL_W / 2;
    const y = (lane: number): number => PAD_T + lane * LANE_H + LANE_H / 2;
    const width = PAD_L + graph.columnCount * COL_W + PAD_R;
    const height = PAD_T + graph.lanes.length * LANE_H + PAD_B;
    const color = (lane: number): string => LANE_COLORS[lane % LANE_COLORS.length];

    const lanes: LaneView[] = graph.lanes.map((lane) => ({
      y: y(lane.index),
      stripeY: PAD_T + lane.index * LANE_H,
      label: lane.label,
      color: color(lane.index),
      even: lane.index % 2 === 0,
    }));

    const edges: EdgeView[] = graph.edges.map((edge) => ({
      path: edgePath(
        x(edge.fromColumn),
        y(edge.fromLane),
        x(edge.toColumn),
        y(edge.toLane),
        edge.kind,
      ),
      color: color(edge.colorLane),
    }));

    const dots: DotView[] = [];
    const pills: PillView[] = [];
    for (const node of graph.nodes) {
      if (node.kind === 'collapsed') {
        pills.push(pillView(node, x(node.column), y(node.lane), color(node.lane)));
        continue;
      }
      dots.push(dotView(node, x(node.column), y(node.lane), color(node.lane), commits));
    }

    return {
      width,
      height,
      lanes,
      edges,
      dots,
      pills,
      commitCount: graph.commitCount,
      laneCount: graph.lanes.length,
    };
  });

  /** The selected commit's metadata, when loaded. */
  protected readonly selected = computed<CommitInfo | null>(() => {
    const sha = this.selectedSha();
    return sha ? (this.commitsBySha().get(sha) ?? null) : null;
  });

  /** Branches not yet in the graph, filtered by the dropdown query. */
  protected readonly addableBranches = computed<readonly string[]>(() => {
    const state = this.branches();
    if (state?.status !== 'ready') return [];
    const loaded = this.readyState()?.heads ?? new Map<string, string>();
    const query = this.filter().trim().toLowerCase();
    return state.names.filter(
      (name) => !loaded.has(name) && (!query || name.toLowerCase().includes(query)),
    );
  });

  constructor() {
    // Keep the viewport anchored to the right edge (the newest commits) across
    // relayouts: initially fromRight = 0 scrolls to the newest, and loading
    // older pages (which grow the graph leftwards) keeps what you look at.
    effect(() => {
      this.view();
      const el = this.scroller()?.nativeElement;
      if (!el) return;
      const fromRight = this.fromRight;
      setTimeout(() => {
        el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth - fromRight);
      });
    });
    // Focus the branch filter as soon as the dropdown opens.
    effect(() => {
      if (this.addOpen()) this.filterInput()?.nativeElement.focus();
    });
  }

  protected onScroll(): void {
    const el = this.scroller()?.nativeElement;
    if (!el) return;
    this.fromRight = Math.max(0, el.scrollWidth - el.clientWidth - el.scrollLeft);
  }

  /** Selects a commit; a sha hidden inside a pill expands that pill first. */
  protected select(sha: string): void {
    const graph = this.graph();
    const pill = graph?.nodes.find(
      (node): node is CollapsedNode => node.kind === 'collapsed' && node.shas.includes(sha),
    );
    if (pill) this.expandPill(pill.id);
    this.selectedSha.set(this.selectedSha() === sha ? null : sha);
  }

  protected expandPill(id: string): void {
    this.expanded.update((expanded) => new Set([...expanded, id]));
  }

  protected collapseRuns(): void {
    this.expanded.set(new Set());
  }

  protected isLoaded(sha: string): boolean {
    return this.commitsBySha().has(sha);
  }

  protected toggleAdd(): void {
    if (this.addOpen()) {
      this.addOpen.set(false);
      return;
    }
    this.filter.set('');
    this.addOpen.set(true);
    this.loadBranches.emit();
  }

  protected chooseBranch(name: string): void {
    this.addOpen.set(false);
    this.addBranch.emit(name);
  }

  protected onFilterInput(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  /** A click outside the add-branch dropdown dismisses it. */
  protected onDocumentClick(event: MouseEvent): void {
    if (!this.addOpen()) return;
    if (!this.host.nativeElement.contains(event.target as Node)) this.addOpen.set(false);
  }

  /** Esc closes the dropdown first, then the detail bar. */
  protected onEscape(event: Event): void {
    if (this.addOpen()) {
      event.preventDefault();
      this.addOpen.set(false);
    } else if (this.selectedSha()) {
      event.preventDefault();
      this.selectedSha.set(null);
    }
  }

  protected abbrev(sha: string): string {
    return shortSha(sha);
  }

  protected when(iso: string): string {
    return relativeTime(iso);
  }
}

/**
 * Edge geometry: same-lane edges are straight; a merge runs along the side
 * lane and curves into its target just before the merge commit; a fork curves
 * out of the parent's lane right after it and then runs straight. Both curves
 * end horizontal, so lanes read as continuous tracks.
 */
function edgePath(x1: number, y1: number, x2: number, y2: number, kind: string): string {
  if (y1 === y2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const bend = Math.min(COL_W * 1.5, x2 - x1);
  if (kind === 'merge') {
    const start = x2 - bend;
    return (
      `M ${x1} ${y1} L ${start} ${y1} ` +
      `C ${start + bend / 2} ${y1} ${start + bend / 2} ${y2} ${x2} ${y2}`
    );
  }
  const end = x1 + bend;
  return `M ${x1} ${y1} C ${x1 + bend / 2} ${y1} ${x1 + bend / 2} ${y2} ${end} ${y2} L ${x2} ${y2}`;
}

function pillView(node: CollapsedNode, x: number, y: number, color: string): PillView {
  const label = String(node.count);
  return {
    id: node.id,
    x,
    y,
    width: Math.max(22, 12 + label.length * 6),
    color,
    count: node.count,
    title: `${node.count} commits — click to expand`,
  };
}

function dotView(
  node: CommitNode,
  x: number,
  y: number,
  color: string,
  commits: ReadonlyMap<string, CommitInfo>,
): DotView {
  const commit = commits.get(node.sha);
  const title = commit
    ? `${shortSha(commit.sha)} · ${commit.summary}\n${commit.authorName} · ${relativeTime(commit.authoredAt)}`
    : shortSha(node.sha);
  const labels: LabelChip[] = node.labels.map((text, index) => {
    const shown = text.length > 24 ? `${text.slice(0, 23)}…` : text;
    return {
      text: shown,
      x,
      y: y - 16 - index * 17,
      width: 14 + shown.length * 5.6,
    };
  });
  return {
    sha: node.sha,
    x,
    y,
    color,
    filled: node.isMerge || node.labels.length > 0,
    clipped: node.clipped,
    labels,
    title,
  };
}
