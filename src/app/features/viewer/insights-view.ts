import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';

import { CoChangeState } from '../../core/store/repo-store';
import {
  CoChangeCluster,
  clusterCoChange,
  computeModuleCoChange,
  relatedFiles,
} from '../../core/util/co-change';
import { Hotspot, heatLevel } from '../../core/util/hotspots';
import { disambiguateLabels } from '../../core/util/path-label';
import { relativeTime } from '../../core/util/relative-time';
import { TreemapTile, squarify } from '../../core/util/treemap';

const MAX_PAIRS = 60;
const MAX_RELATED = 100;
const MAX_HOTSPOTS = 45;
const MAX_CLUSTERS = 10;
/** Cluster-size range bounds: the floor can dip to 2 (a bare pair) on demand. */
const CLUSTER_SIZE_FLOOR = 2;
const CLUSTER_SIZE_CEIL = 50;
/** Default visible band: 3 up to 20 files; bigger ones become hairballs. */
const DEFAULT_MIN_CLUSTER_FILES = 3;
const DEFAULT_MAX_CLUSTER_FILES = 20;
/** Default folder depth for module coupling (e.g. `src/auth`), adjustable 1–4. */
const DEFAULT_MODULE_DEPTH = 2;
const MODULE_MIN_SUPPORT = 2;
/** Module clusters are the architecture story, so keep a generous size band. */
const MODULE_CLUSTER_MIN_FILES = 3;
const MODULE_CLUSTER_MAX_FILES = 12;
/** Treemap coordinate space (16:9, scaled uniformly to fill its box). */
const TREEMAP_W = 1600;
const TREEMAP_H = 900;
/** Per-cluster graph coordinate space. */
const CLUSTER_W = 240;
const CLUSTER_H = 220;
/** Cold → hot fills, indexed by heat level. */
const HEAT_FILLS = ['#3f3f46', '#854d0e', '#b45309', '#ea580c', '#ef4444'];

interface GraphNode {
  readonly path: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
}
interface GraphEdge {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** Edge midpoint — where the weight label sits. */
  readonly mx: number;
  readonly my: number;
  /** Stroke width and opacity, both scaled from the coupling degree. */
  readonly width: number;
  readonly opacity: number;
  /** Co-change count (raw) and Jaccard degree (the labelled coupling strength). */
  readonly support: number;
  readonly degree: number;
}
interface ClusterGraph {
  readonly files: number;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/**
 * Repository Insights — a metrics view over recent history, from one capped (or
 * full, on demand) commit walk.
 *
 * **Hotspots**: files ranked by recency-weighted churn, as a treemap + list.
 * **Coupling**: files that change together, as the top clusters (node-link
 * graphs) + the pair list, and filterable to one file's full-history coupling.
 */
@Component({
  selector: 'app-insights-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  host: { class: 'flex h-full min-h-0 flex-col bg-zinc-950' },
  // A two-thumb range slider: two native range inputs overlaid on one track.
  // Only the thumbs take pointer events, so both handles stay grabbable.
  styles: `
    .dual-range input[type='range'] {
      -webkit-appearance: none;
      appearance: none;
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      margin: 0;
      background: transparent;
      pointer-events: none;
    }
    .dual-range input[type='range']:focus-visible {
      outline: none;
    }
    .dual-range input[type='range']::-webkit-slider-thumb {
      -webkit-appearance: none;
      pointer-events: auto;
      height: 0.75rem;
      width: 0.75rem;
      border-radius: 9999px;
      background: #818cf8;
      border: 2px solid #18181b;
      cursor: pointer;
    }
    .dual-range input[type='range']::-moz-range-thumb {
      pointer-events: auto;
      height: 0.75rem;
      width: 0.75rem;
      border-radius: 9999px;
      background: #818cf8;
      border: 2px solid #18181b;
      cursor: pointer;
    }
    .dual-range input[type='range']:focus-visible::-webkit-slider-thumb {
      outline: 2px solid #a5b4fc;
      outline-offset: 1px;
    }
    .dual-range input[type='range']:focus-visible::-moz-range-thumb {
      outline: 2px solid #a5b4fc;
      outline-offset: 1px;
    }
  `,
  template: `
    <!-- One coupling cluster as a node-link graph; reused for files and modules. -->
    <ng-template #graphCard let-graph let-clickable="clickable" let-unit="unit">
      <div class="rounded border border-zinc-800 bg-zinc-900/30 p-1">
        <svg [attr.viewBox]="'0 0 ' + clusterW + ' ' + clusterH" class="w-full" role="img">
          @for (edge of graph.edges; track $index) {
            <g>
              <title>
                change together {{ pct(edge.degree) }}% of the time ({{ edge.support }} commits)
              </title>
              <line
                [attr.x1]="edge.x1"
                [attr.y1]="edge.y1"
                [attr.x2]="edge.x2"
                [attr.y2]="edge.y2"
                stroke="#818cf8"
                [attr.stroke-opacity]="edge.opacity"
                [attr.stroke-width]="edge.width"
              />
              <text
                [attr.x]="edge.mx"
                [attr.y]="edge.my"
                text-anchor="middle"
                dominant-baseline="central"
                font-size="9"
                fill="#c7d2fe"
                stroke="#09090b"
                stroke-width="2.5"
                paint-order="stroke"
                class="pointer-events-none font-mono tabular-nums"
              >
                {{ pct(edge.degree) }}%
              </text>
            </g>
          }
          @for (node of graph.nodes; track node.path) {
            <g [class.cursor-pointer]="clickable" (click)="onNodeClick(node.path, clickable)">
              <title>{{ node.path }}</title>
              <circle [attr.cx]="node.x" [attr.cy]="node.y" r="5" fill="#818cf8" />
              <text
                [attr.x]="node.x"
                [attr.y]="node.y - 9"
                text-anchor="middle"
                font-size="11"
                fill="#e4e4e7"
                class="pointer-events-none font-mono"
              >
                {{ node.label }}
              </text>
            </g>
          }
        </svg>
        <p class="text-center text-[11px] text-zinc-600">{{ graph.files }} {{ unit }}</p>
      </div>
    </ng-template>

    <header
      class="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-4"
    >
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
        <path d="M3 3v18h18" />
        <path d="m7 14 4-4 3 3 5-5" />
      </svg>
      <h2 class="text-sm font-semibold tracking-tight text-zinc-100">Insights</h2>
      <span class="flex-1"></span>
      @if (state() || focus()) {
        <button
          type="button"
          class="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
          (click)="clear.emit()"
        >
          Reset
        </button>
      }
    </header>

    <div class="slim-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
      @if (state() || focus()) {
        <!-- Tabs are always available once anything has been analysed. -->
        <div class="mb-3 flex items-center gap-3 text-xs">
          <button
            type="button"
            class="border-b-2 pb-1 font-medium transition"
            [class]="
              tab() === 'hotspots'
                ? 'border-indigo-400 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            "
            (click)="tab.set('hotspots')"
          >
            Hotspots
          </button>
          <button
            type="button"
            class="border-b-2 pb-1 font-medium transition"
            [class]="
              tab() === 'coupling'
                ? 'border-indigo-400 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            "
            (click)="tab.set('coupling')"
          >
            Coupling
          </button>
          <span class="flex-1"></span>
          @if (state(); as s) {
            <span class="text-zinc-600">
              @if (s.status === 'computing') {
                {{ s.scanned }}{{ s.target === Infinity ? '' : '/' + s.target }} commits…
              } @else {
                {{ s.result.commitsUsed }} commits
              }
            </span>
          }
        </div>

        @if (tab() === 'hotspots') {
          @if (state(); as s) {
            @if (s.status === 'error') {
              <p class="text-sm text-rose-400">{{ s.message }}</p>
            } @else if (s.message) {
              <p class="text-sm text-zinc-500">{{ s.message }}</p>
            } @else {
              <p class="mb-2 text-xs text-zinc-500">
                Hottest files by recent churn — click a file to open it.
              </p>
              @if (tiles().length) {
                <svg
                  class="aspect-[16/9] w-full rounded border border-zinc-800"
                  [attr.viewBox]="'0 0 ' + treemapW + ' ' + treemapH"
                  preserveAspectRatio="xMidYMid meet"
                >
                  @for (tile of tiles(); track tile.value.path) {
                    <g class="cursor-pointer" (click)="openFile.emit(tile.value.path)">
                      <title>
                        {{ tile.value.path }} — score {{ score(tile.value) }},
                        {{ tile.value.metric.revisions }} changes
                      </title>
                      <rect
                        [attr.x]="tile.x"
                        [attr.y]="tile.y"
                        [attr.width]="tile.w"
                        [attr.height]="tile.h"
                        [attr.fill]="fill(tile.value)"
                        stroke="#18181b"
                        stroke-width="2"
                        class="transition-opacity hover:opacity-80"
                      />
                      @if (tile.w > 120 && tile.h > 40) {
                        <text
                          [attr.x]="tile.x + 6"
                          [attr.y]="tile.y + 22"
                          fill="#fafafa"
                          font-size="15"
                          class="pointer-events-none font-mono"
                        >
                          {{ label(tile.value.path) }}
                        </text>
                      }
                    </g>
                  }
                </svg>
                <ul class="mt-3 space-y-0.5">
                  @for (hot of list(); track hot.path) {
                    <li>
                      <button
                        type="button"
                        class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm transition hover:bg-white/[0.03]"
                        [title]="hot.path + ' — score ' + score(hot)"
                        (click)="openFile.emit(hot.path)"
                      >
                        <span
                          class="size-2 shrink-0 rounded-sm"
                          [style.background]="fill(hot)"
                        ></span>
                        <span class="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">{{
                          label(hot.path)
                        }}</span>
                        <span class="shrink-0 text-[11px] text-zinc-500 tabular-nums">
                          {{ hot.metric.revisions }}×
                        </span>
                        @if (hot.metric.lastChange; as last) {
                          <span class="shrink-0 text-[11px] text-zinc-600">{{ when(last) }}</span>
                        }
                      </button>
                    </li>
                  }
                </ul>
              } @else if (s.status === 'ready') {
                <p class="text-sm text-zinc-500">No file activity in the analysed commits.</p>
              } @else {
                <p class="text-sm text-zinc-500">Crunching hotspots…</p>
              }
            }
          } @else {
            <p class="mb-3 text-sm text-zinc-500">Analyze the history to see hotspots.</p>
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-400"
                (click)="analyze.emit()"
              >
                Analyze recent history
              </button>
              <button
                type="button"
                class="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
                (click)="loadAll.emit()"
              >
                Load all commits
              </button>
            </div>
          }
        } @else {
          <!-- Coupling tab -->
          @if (focus(); as f) {
            <div class="mb-3 flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate text-sm text-zinc-200">
                Coupling for
                <span class="font-mono" [title]="f.focus">{{ label(f.focus ?? '') }}</span>
              </span>
              <button
                type="button"
                class="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
                (click)="openFile.emit(f.focus ?? '')"
              >
                Open file
              </button>
              <button
                type="button"
                class="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
                (click)="clearFocus.emit()"
              >
                Clear filter
              </button>
            </div>
            <p class="mb-3 text-xs text-zinc-500">
              @if (f.status === 'computing') {
                Walking this file's history… {{ f.scanned }} commits
              } @else if (f.status === 'error') {
                {{ f.message }}
              } @else if (f.message) {
                {{ f.message }}
              } @else {
                Only files that change with it, across all {{ f.result.commitsUsed }}
                {{ f.result.commitsUsed === 1 ? 'commit' : 'commits' }} that touched it — click one
                to filter by it.
              }
            </p>
            @if (focusRelated().length) {
              <ul class="space-y-1">
                @for (rel of focusRelated(); track rel.path) {
                  <li
                    class="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-white/[0.03]"
                  >
                    <button
                      type="button"
                      class="min-w-0 flex-1 truncate text-left font-mono text-xs text-zinc-200 underline-offset-2 hover:text-indigo-300 hover:underline"
                      [title]="rel.path"
                      (click)="focusFile.emit(rel.path)"
                    >
                      {{ label(rel.path) }}
                    </button>
                    <span class="shrink-0 text-[11px] text-zinc-500 tabular-nums">
                      {{ rel.support }}× · {{ pct(rel.confidence) }}%
                    </span>
                  </li>
                }
              </ul>
            } @else if (f.status === 'ready') {
              <p class="text-sm text-zinc-500">
                {{ label(f.focus ?? '') }} hasn't changed alongside other files in its history.
              </p>
            }
          } @else if (state(); as s) {
            @if (s.status === 'error') {
              <p class="text-sm text-rose-400">{{ s.message }}</p>
            } @else if (s.message) {
              <p class="text-sm text-zinc-500">{{ s.message }}</p>
            } @else if (s.result.commitsUsed) {
              <!--
                Gated on commits analysed (not file pairs): module coupling can
                exist even when no file pair clears minSupport, so the toggle
                must stay reachable. Each mode renders its own empty state.
              -->
              <div class="mb-2 flex items-center gap-3 text-xs text-zinc-500">
                <span
                  class="inline-flex overflow-hidden rounded border border-zinc-700"
                  role="group"
                  aria-label="Coupling granularity"
                >
                  <button
                    type="button"
                    class="px-2 py-0.5 transition"
                    [class]="
                      granularity() === 'files'
                        ? 'bg-zinc-700/60 font-medium text-zinc-200'
                        : 'hover:bg-white/10'
                    "
                    [attr.aria-pressed]="granularity() === 'files'"
                    (click)="granularity.set('files')"
                  >
                    Files
                  </button>
                  <button
                    type="button"
                    class="border-l border-zinc-700 px-2 py-0.5 transition"
                    [class]="
                      granularity() === 'modules'
                        ? 'bg-zinc-700/60 font-medium text-zinc-200'
                        : 'hover:bg-white/10'
                    "
                    [attr.aria-pressed]="granularity() === 'modules'"
                    (click)="granularity.set('modules')"
                  >
                    Modules
                  </button>
                </span>
                <span class="flex-1"></span>
                @if (granularity() === 'modules') {
                  <label
                    class="flex items-center gap-1.5"
                    title="How many folder levels deep to group files into modules"
                  >
                    <span class="text-zinc-600">folder depth</span>
                    <input
                      type="range"
                      min="1"
                      max="4"
                      step="1"
                      [value]="moduleDepth()"
                      (input)="onModuleDepth($event)"
                      class="h-1 w-20 cursor-pointer accent-indigo-400"
                      aria-label="Module depth"
                    />
                    <span class="tabular-nums text-zinc-400">{{ moduleDepth() }}</span>
                    @if (moduleExample()) {
                      <span class="text-zinc-600">·</span>
                      <span class="max-w-40 truncate font-mono text-zinc-400"
                        >e.g. {{ moduleExample() }}</span
                      >
                    }
                  </label>
                } @else {
                  <span class="text-zinc-600">files</span>
                  <span class="w-7 text-right tabular-nums text-zinc-400">{{
                    minClusterSize()
                  }}</span>
                  <span
                    class="dual-range relative h-3 w-28"
                    role="group"
                    aria-label="Cluster size range"
                  >
                    <span
                      class="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded bg-zinc-700"
                    ></span>
                    <span
                      class="pointer-events-none absolute top-1/2 h-1 -translate-y-1/2 rounded bg-indigo-400"
                      [style.left.%]="rangePercent().left"
                      [style.right.%]="rangePercent().right"
                    ></span>
                    <input
                      type="range"
                      [min]="floor"
                      [max]="ceil"
                      step="1"
                      [value]="minClusterSize()"
                      (input)="onMinClusterSize($event)"
                      aria-label="Minimum cluster size"
                    />
                    <input
                      type="range"
                      [min]="floor"
                      [max]="ceil"
                      step="1"
                      [value]="maxClusterSize()"
                      (input)="onMaxClusterSize($event)"
                      aria-label="Maximum cluster size"
                    />
                  </span>
                  <span class="w-7 tabular-nums text-zinc-400">{{ maxClusterSize() }}</span>
                }
              </div>
              @if (granularity() === 'modules') {
                <p class="mb-2 text-xs text-zinc-500">
                  Folders that change together — each edge is how often they change in the same
                  commit. Cross-boundary coupling is the architectural-decay smell; within-folder
                  churn collapses away. Use <span class="text-zinc-400">folder depth</span> to set
                  how finely folders are grouped.
                </p>
                @if (moduleClusterGraphs().length) {
                  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    @for (graph of moduleClusterGraphs(); track $index) {
                      <ng-container
                        [ngTemplateOutlet]="graphCard"
                        [ngTemplateOutletContext]="{
                          $implicit: graph,
                          clickable: false,
                          unit: 'modules',
                        }"
                      />
                    }
                  </div>
                  <p
                    class="mt-3 mb-1 text-[11px] font-medium tracking-wide text-zinc-500 uppercase"
                  >
                    All module pairs
                  </p>
                }
                @if (modulePairs().length) {
                  <ul class="space-y-1">
                    @for (pair of modulePairs(); track $index) {
                      <li class="flex items-center gap-2 rounded px-2 py-1.5 text-sm">
                        <span class="flex min-w-0 flex-1 items-center gap-1.5">
                          <span class="truncate font-mono text-xs text-zinc-200" [title]="pair.a">{{
                            moduleLabel(pair.a)
                          }}</span>
                          <span class="shrink-0 text-zinc-600">↔</span>
                          <span class="truncate font-mono text-xs text-zinc-200" [title]="pair.b">{{
                            moduleLabel(pair.b)
                          }}</span>
                        </span>
                        <span class="shrink-0 text-[11px] text-zinc-500 tabular-nums">
                          {{ pair.support }}× · {{ pct(pair.degree) }}%
                        </span>
                      </li>
                    }
                  </ul>
                  @if (moduleMore() > 0) {
                    <p class="mt-2 text-[11px] text-zinc-600">
                      +{{ moduleMore() }} more module pairs
                    </p>
                  }
                } @else if (s.status === 'computing') {
                  <p class="text-sm text-zinc-500">Finding coupling…</p>
                } @else {
                  <p class="text-sm text-zinc-500">
                    No modules change together at depth {{ moduleDepth() }} — try a different depth.
                  </p>
                }
              } @else {
                @if (pairs().length) {
                  <p class="mb-2 text-xs text-zinc-500">
                    Most-coupled clusters — each edge is how often the two files change in the same
                    commit. Click a file to filter by it.
                  </p>
                  @if (clusters().length) {
                    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      @for (graph of clusterGraphs(); track $index) {
                        <ng-container
                          [ngTemplateOutlet]="graphCard"
                          [ngTemplateOutletContext]="{
                            $implicit: graph,
                            clickable: true,
                            unit: 'files',
                          }"
                        />
                      }
                    </div>
                    <p
                      class="mt-3 mb-1 text-[11px] font-medium tracking-wide text-zinc-500 uppercase"
                    >
                      All pairs
                    </p>
                  }
                  <ul class="space-y-1">
                    @for (pair of pairs(); track $index) {
                      <li
                        class="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-white/[0.03]"
                      >
                        <span class="flex min-w-0 flex-1 items-center gap-1.5">
                          <button
                            type="button"
                            class="truncate font-mono text-xs text-zinc-200 underline-offset-2 hover:text-indigo-300 hover:underline"
                            [title]="pair.a"
                            (click)="focusFile.emit(pair.a)"
                          >
                            {{ label(pair.a) }}
                          </button>
                          <span class="shrink-0 text-zinc-600">↔</span>
                          <button
                            type="button"
                            class="truncate font-mono text-xs text-zinc-200 underline-offset-2 hover:text-indigo-300 hover:underline"
                            [title]="pair.b"
                            (click)="focusFile.emit(pair.b)"
                          >
                            {{ label(pair.b) }}
                          </button>
                        </span>
                        <span class="shrink-0 text-[11px] text-zinc-500 tabular-nums">
                          {{ pair.support }}× · {{ pct(pair.degree) }}%
                        </span>
                      </li>
                    }
                  </ul>
                  @if (more() > 0) {
                    <p class="mt-2 text-[11px] text-zinc-600">+{{ more() }} more pairs</p>
                  }
                } @else if (s.status === 'computing') {
                  <p class="text-sm text-zinc-500">Finding coupling…</p>
                } @else {
                  <p class="text-sm text-zinc-500">
                    No files changed together often enough in the analysed commits.
                  </p>
                }
              }
            } @else if (s.status === 'ready') {
              <p class="text-sm text-zinc-500">
                No files changed together often enough in the analysed commits.
              </p>
            } @else {
              <p class="text-sm text-zinc-500">Finding coupling…</p>
            }
          } @else {
            <p class="text-sm text-zinc-500">
              Pick a file in the tree to filter, or analyze the history.
            </p>
          }
        }
      } @else {
        <div class="mx-auto max-w-md py-10 text-center">
          <h3 class="text-sm font-medium text-zinc-200">Find files that change together</h3>
          <p class="mt-2 text-xs leading-5 text-zinc-500">
            Analyze the last {{ commitCap() }} commits for **hotspots** (files churning the most,
            recently) and **change coupling** (files that change together) — or load the whole
            history. One request per commit, so on the anonymous API budget add a token first.
          </p>
          <div class="mt-4 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              class="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-400"
              (click)="analyze.emit()"
            >
              Analyze recent history
            </button>
            <button
              type="button"
              class="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
              (click)="loadAll.emit()"
            >
              Load all commits
            </button>
          </div>
        </div>
      }
    </div>
  `,
})
export class InsightsView {
  /** Repo-wide analysis (hotspots + coupling overview). */
  readonly state = input<CoChangeState | null>(null);
  /** Active "filter coupling by file" result, or null. */
  readonly focus = input<CoChangeState | null>(null);
  readonly commitCap = input<number>(75);

  readonly analyze = output<void>();
  readonly loadAll = output<void>();
  /** Full reset (drops the overview and any filter). */
  readonly clear = output<void>();
  /** Filter coupling by a file (its full history). */
  readonly focusFile = output<string>();
  /** Remove the file filter, keeping the overview. */
  readonly clearFocus = output<void>();
  /** Leave Insights and open a file. */
  readonly openFile = output<string>();

  protected readonly Infinity = Number.POSITIVE_INFINITY;
  protected readonly treemapW = TREEMAP_W;
  protected readonly treemapH = TREEMAP_H;
  protected readonly clusterW = CLUSTER_W;
  protected readonly clusterH = CLUSTER_H;
  protected readonly tab = signal<'hotspots' | 'coupling'>('hotspots');
  protected readonly floor = CLUSTER_SIZE_FLOOR;
  protected readonly ceil = CLUSTER_SIZE_CEIL;
  protected readonly minClusterSize = signal(DEFAULT_MIN_CLUSTER_FILES);
  protected readonly maxClusterSize = signal(DEFAULT_MAX_CLUSTER_FILES);

  /** The selected band as track percentages, for the slider's filled segment. */
  protected readonly rangePercent = computed(() => {
    const span = this.ceil - this.floor || 1;
    return {
      left: ((this.minClusterSize() - this.floor) / span) * 100,
      right: ((this.ceil - this.maxClusterSize()) / span) * 100,
    };
  });

  /** Coupling granularity: individual files vs. rolled-up folder modules. */
  protected readonly granularity = signal<'files' | 'modules'>('files');
  protected readonly moduleDepth = signal(DEFAULT_MODULE_DEPTH);

  protected readonly pairs = computed(() => (this.state()?.result.pairs ?? []).slice(0, MAX_PAIRS));
  protected readonly more = computed(() =>
    Math.max(0, (this.state()?.result.pairs.length ?? 0) - MAX_PAIRS),
  );

  /** Coupling rolled up to folder modules, re-bucketed live by the depth slider. */
  private readonly moduleResult = computed(() =>
    computeModuleCoChange(this.state()?.commits ?? [], {
      depth: this.moduleDepth(),
      minSupport: MODULE_MIN_SUPPORT,
    }),
  );
  protected readonly modulePairs = computed(() => this.moduleResult().pairs.slice(0, MAX_PAIRS));
  protected readonly moduleMore = computed(() =>
    Math.max(0, this.moduleResult().pairs.length - MAX_PAIRS),
  );
  /** The busiest module at the current depth — a live "what depth does" example. */
  protected readonly moduleExample = computed(() => {
    let best: string | null = null;
    let bestCount = -1;
    for (const [module, count] of this.moduleResult().changes) {
      if (count > bestCount) {
        bestCount = count;
        best = module;
      }
    }
    return best === null ? '' : this.moduleLabel(best);
  });
  protected readonly focusRelated = computed(() => {
    const f = this.focus();
    return f?.focus ? relatedFiles(f.result, f.focus, MAX_RELATED) : [];
  });

  protected readonly clusters = computed(() =>
    clusterCoChange(this.state()?.result.pairs ?? [], {
      limit: MAX_CLUSTERS,
      minFiles: this.minClusterSize(),
      maxFiles: this.maxClusterSize(),
    }),
  );
  protected readonly clusterGraphs = computed(() =>
    this.clusters().map((c) => this.layout(c, (p) => this.label(p))),
  );

  /** Module clusters drawn as graphs — the architecture entanglement, visualised. */
  private readonly moduleClusters = computed(() =>
    clusterCoChange(this.moduleResult().pairs, {
      limit: MAX_CLUSTERS,
      minFiles: MODULE_CLUSTER_MIN_FILES,
      maxFiles: MODULE_CLUSTER_MAX_FILES,
    }),
  );
  protected readonly moduleClusterGraphs = computed(() =>
    this.moduleClusters().map((c) => this.layout(c, (p) => this.moduleLabel(p))),
  );

  private readonly hotspots = computed(() => (this.state()?.hotspots ?? []).slice(0, MAX_HOTSPOTS));
  protected readonly list = computed(() => this.hotspots());
  protected readonly tiles = computed<TreemapTile<Hotspot>[]>(() =>
    squarify(
      // A touched file missing from the current tree has size 0; squarify drops
      // non-positive weights, so clamp to keep it a (tiny) tile — otherwise it
      // would show in the ranked list but never in the treemap.
      this.hotspots().map((hot) => ({ weight: Math.max(hot.size, 1), value: hot })),
      TREEMAP_W,
      TREEMAP_H,
    ),
  );

  /** Display labels for every file shown, full-path when basenames collide. */
  private readonly labels = computed(() => {
    const paths = new Set<string>();
    const focus = this.focus()?.focus;
    if (focus) paths.add(focus);
    for (const rel of this.focusRelated()) paths.add(rel.path);
    for (const pair of this.pairs()) {
      paths.add(pair.a);
      paths.add(pair.b);
    }
    for (const hot of this.hotspots()) paths.add(hot.path);
    for (const cluster of this.clusters()) for (const file of cluster.files) paths.add(file);
    return disambiguateLabels(paths);
  });

  constructor() {
    // Applying a file filter is a coupling action — show that tab.
    effect(() => {
      if (this.focus()) this.tab.set('coupling');
    });
  }

  private layout(cluster: CoChangeCluster, labelOf: (path: string) => string): ClusterGraph {
    const cx = CLUSTER_W / 2;
    const cy = CLUSTER_H / 2 + 6;
    const radius = 78;
    const n = cluster.files.length;
    const pos = new Map<string, { x: number; y: number }>();
    cluster.files.forEach((path, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2;
      pos.set(path, {
        x: n === 1 ? cx : cx + radius * Math.cos(angle),
        y: n === 1 ? cy : cy + radius * Math.sin(angle),
      });
    });
    const nodes = cluster.files.map((path) => ({
      path,
      label: labelOf(path),
      ...pos.get(path)!,
    }));
    const edges = cluster.edges.map((edge) => {
      const a = pos.get(edge.a)!;
      const b = pos.get(edge.b)!;
      return {
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
        // Both width and opacity track the coupling strength, so a strong edge
        // reads as strong even before you read its label.
        width: 1.5 + edge.degree * 5,
        opacity: 0.25 + edge.degree * 0.55,
        support: edge.support,
        degree: edge.degree,
      };
    });
    return { files: n, nodes, edges };
  }

  /** A graph node was clicked — only the file view filters on it. */
  protected onNodeClick(path: string, clickable: boolean): void {
    if (clickable) this.focusFile.emit(path);
  }

  /** The two handles can't cross: each clamps against the other. */
  protected onMinClusterSize(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.minClusterSize.set(Math.min(value, this.maxClusterSize()));
  }

  protected onMaxClusterSize(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.maxClusterSize.set(Math.max(value, this.minClusterSize()));
  }

  protected onModuleDepth(event: Event): void {
    this.moduleDepth.set(Number((event.target as HTMLInputElement).value));
  }

  /** A module is a folder path; the repository root reads as "(root)". */
  protected moduleLabel(module: string): string {
    return module === '' ? '(root)' : module;
  }

  protected fill(hot: Hotspot): string {
    return HEAT_FILLS[heatLevel(hot.metric.score)];
  }

  protected score(hot: Hotspot): string {
    return hot.metric.score.toFixed(1);
  }

  protected pct(fraction: number): number {
    return Math.round(fraction * 100);
  }

  protected label(path: string): string {
    return this.labels().get(path) ?? path.slice(path.lastIndexOf('/') + 1);
  }

  protected when(iso: string): string {
    return relativeTime(iso);
  }
}
