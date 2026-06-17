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
} from '@angular/core';

import { CoChangeState } from '../../core/store/repo-store';
import { CoChangeCluster, clusterCoChange, relatedFiles } from '../../core/util/co-change';
import { ForceEdge, Point, forceLayout } from '../../core/util/force-layout';
import { HEAT_THRESHOLDS, Hotspot } from '../../core/util/hotspots';
import { AuthorPresence, KnowledgeRisk, RISK_THRESHOLDS } from '../../core/util/knowledge';
import { disambiguateLabels } from '../../core/util/path-label';
import { relativeTime } from '../../core/util/relative-time';
import {
  Collaboration,
  Collaborator,
  Developer,
  EMPTY_TEAM_GRAPH,
  TeamGraph,
  blendStrength,
  collaboratorsOf,
} from '../../core/util/team-graph';
import { TreemapTile, squarify } from '../../core/util/treemap';

const MAX_PAIRS = 60;
const MAX_RELATED = 100;
const MAX_HOTSPOTS = 45;
const MAX_RISK = 45;
/** Contributors listed in the Knowledge "holders" breakdown. */
const MAX_HOLDERS = 10;
/** Risk-quadrant hover tooltip box, in treemap viewBox units. */
const QUAD_TIP_W = 640;
const QUAD_TIP_H = 150;
const MAX_CLUSTERS = 10;
/** Cluster-size range bounds: the floor can dip to 2 (a bare pair) on demand. */
const CLUSTER_SIZE_FLOOR = 2;
const CLUSTER_SIZE_CEIL = 50;
/** Default visible band: 3 up to 20 files; bigger ones become hairballs. */
const DEFAULT_MIN_CLUSTER_FILES = 3;
const DEFAULT_MAX_CLUSTER_FILES = 20;
/** Treemap coordinate space (16:9, scaled uniformly to fill its box). */
const TREEMAP_W = 1600;
const TREEMAP_H = 900;
/** Per-cluster graph coordinate space. */
const CLUSTER_W = 240;
const CLUSTER_H = 220;
/**
 * Rotate the ring of nodes ~20° off the cardinal axes. Labels are centered
 * above each node, so they collide most when nodes share a baseline (e.g. two
 * level on a horizontal axis); the tilt staggers their heights while the text
 * itself stays horizontal and readable.
 */
const CLUSTER_ROTATION = (20 * Math.PI) / 180;
/** Cold → hot fills, anchored at the five heat/risk thresholds. */
const HEAT_FILLS = ['#3f3f46', '#854d0e', '#b45309', '#ea580c', '#ef4444'];

/** Most active developers drawn in the team graph (the rest stay in the data). */
const MAX_DEVELOPERS = 40;
/** Strongest collaboration ties drawn, to keep the graph from hairballing. */
const MAX_TEAM_EDGES = 140;
/** Collaborators listed for the selected developer. */
const MAX_COLLABORATORS = 60;
/** "Most connected" developers shown when nothing is selected. */
const MAX_CONNECTORS = 8;
/** Team-graph coordinate space (16:9, scaled to fill its box). */
const TEAM_W = 1600;
const TEAM_H = 900;
/** Padding (viewBox units) kept around the fitted graph for discs + labels. */
const TEAM_MARGIN = 150;
/** Categorical node fills, indexed by connected component (the "teams"). */
const TEAM_COLORS = [
  '#818cf8',
  '#34d399',
  '#fbbf24',
  '#f472b6',
  '#60a5fa',
  '#a78bfa',
  '#fb923c',
  '#22d3ee',
];
/** Fill for a developer who shares no files with anyone (a silo). */
const SILO_FILL = '#52525b';
/** Default blend toward the temporal (recent-collaboration) tie strength. */
const DEFAULT_TEMPORAL_WEIGHT = 0.5;
/** Edge pull (< 1) for the team layout — loosens tight clusters so labels stay legible. */
const TEAM_ATTRACTION = 0.3;

/** Linear interpolation between two `#rrggbb` colours, `t` clamped to [0,1]. */
function lerpHex(from: string, to: string, t: number): string {
  const c = Math.max(0, Math.min(1, t));
  const f = parseInt(from.slice(1), 16);
  const g = parseInt(to.slice(1), 16);
  const mix = (shift: number): number => {
    const a = (f >> shift) & 255;
    const b = (g >> shift) & 255;
    return Math.round(a + (b - a) * c);
  };
  return `#${((1 << 24) | (mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).slice(1)}`;
}

/**
 * Cold → hot fill for `value`, interpolated *continuously* between the
 * {@link HEAT_FILLS} stops anchored at `thresholds` (the same absolute scale the
 * file-tree heat badges use, so a colour means the same thing across the app).
 * Unlike a hard five-bucket mapping, a low-but-nonzero value reads as a faint
 * warm tint rather than the same flat grey as zero — which is what lets the
 * treemap actually show variation when most scores sit below the first bucket.
 */
function heatColor(value: number, thresholds: readonly number[]): string {
  if (value <= thresholds[0]) return HEAT_FILLS[0];
  for (let i = 1; i < thresholds.length; i++) {
    if (value < thresholds[i]) {
      const span = thresholds[i] - thresholds[i - 1] || 1;
      return lerpHex(HEAT_FILLS[i - 1], HEAT_FILLS[i], (value - thresholds[i - 1]) / span);
    }
  }
  return HEAT_FILLS[HEAT_FILLS.length - 1];
}

/** Human-readable byte size for the size-filter readout. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

/** Median of a numeric list (0 for empty). */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

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
  readonly width: number;
}
interface ClusterGraph {
  readonly files: number;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/** One developer placed in the team graph. */
interface TeamNode {
  /** Stable identity — the selection/edge key. */
  readonly id: string;
  /** Display name (also the node's tooltip). */
  readonly name: string;
  /** Short display label (the full name is in the node's tooltip). */
  readonly label: string;
  readonly x: number;
  readonly y: number;
  /** Disc radius, scaled by commit count. */
  readonly r: number;
  /** Label anchor point and text alignment, fanned radially off the disc. */
  readonly lx: number;
  readonly ly: number;
  readonly anchor: 'start' | 'middle' | 'end';
  readonly fill: string;
  readonly commits: number;
  readonly files: number;
  readonly collaborators: number;
}
interface TeamEdge {
  readonly a: string;
  readonly b: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly width: number;
  readonly strength: number;
}
interface TeamLayout {
  readonly nodes: readonly TeamNode[];
  readonly edges: readonly TeamEdge[];
}

/** One file plotted in the knowledge-risk quadrant. */
interface QuadrantPoint {
  readonly file: KnowledgeRisk;
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly fill: string;
}
/** The knowledge-risk scatter: bubbles plus the median crosshair and plot box. */
interface Quadrant {
  readonly points: readonly QuadrantPoint[];
  readonly midX: number;
  readonly midY: number;
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/**
 * Repository Insights — a metrics view over recent history, from one capped (or
 * full, on demand) commit walk.
 *
 * **Hotspots**: files ranked by recency-weighted churn, as a treemap + list.
 * **Coupling**: files that change together, as the top clusters (node-link
 * graphs) + the pair list, and filterable to one file's full-history coupling.
 * **Team**: a developer social graph — who works with whom, inferred from
 * shared file authorship, surfacing collaborators, connectors and silos.
 * **Knowledge**: files at risk of knowledge loss — authored knowledge whose
 * contributors have gone quiet — as a risk treemap + ranked list.
 */
@Component({
  selector: 'app-insights-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
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
          <button
            type="button"
            class="border-b-2 pb-1 font-medium transition"
            [class]="
              tab() === 'team'
                ? 'border-indigo-400 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            "
            (click)="tab.set('team')"
          >
            Team
          </button>
          <button
            type="button"
            class="border-b-2 pb-1 font-medium transition"
            [class]="
              tab() === 'knowledge'
                ? 'border-indigo-400 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            "
            (click)="tab.set('knowledge')"
          >
            Knowledge
          </button>
          <span class="flex-1"></span>
          @if (state(); as s) {
            <span class="text-zinc-600">
              @if (s.status === 'computing') {
                {{ s.scanned }}{{ s.target === Infinity ? '' : '/' + s.target }} commits…
              } @else {
                {{ s.result.commitsUsed }} commits
              }
              @if (s.excludedFiles) {
                <span
                  class="text-zinc-700"
                  [title]="
                    s.excludedFiles +
                    ' generated/vendored files (lockfiles, build output, minified assets) are excluded from these metrics'
                  "
                  >· {{ s.excludedFiles }} generated hidden</span
                >
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
              <div class="mb-2 flex items-center gap-3 text-xs text-zinc-500">
                <span>Hottest files by recent churn — click a file to open it.</span>
                @if (canFilterBySize()) {
                  <span class="flex-1"></span>
                  <span class="text-zinc-600">max size</span>
                  <span
                    class="dual-range relative h-3 w-28"
                    role="group"
                    aria-label="Maximum file size"
                  >
                    <span
                      class="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded bg-zinc-700"
                    ></span>
                    <span
                      class="pointer-events-none absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded bg-indigo-400"
                      [style.right.%]="100 - maxFileSizePct()"
                    ></span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="1"
                      [value]="maxFileSizePct()"
                      (input)="onMaxFileSize($event)"
                      aria-label="Maximum file size"
                    />
                  </span>
                  <span class="w-16 text-right tabular-nums text-zinc-400">{{ sizeLabel() }}</span>
                }
              </div>
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
                @if (anyHotspots()) {
                  <p class="text-sm text-zinc-500">No files within the selected size range.</p>
                } @else {
                  <p class="text-sm text-zinc-500">No file activity in the analysed commits.</p>
                }
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
        } @else if (tab() === 'coupling') {
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
            } @else if (pairs().length) {
              <div class="mb-2 flex items-center gap-3 text-xs text-zinc-500">
                <span>Most-coupled clusters — click a file to filter by it.</span>
                <span class="flex-1"></span>
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
              </div>
              @if (clusters().length) {
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  @for (graph of clusterGraphs(); track $index) {
                    <div class="rounded border border-zinc-800 bg-zinc-900/30 p-1">
                      <svg
                        [attr.viewBox]="'0 0 ' + clusterW + ' ' + clusterH"
                        class="w-full"
                        role="img"
                      >
                        @for (edge of graph.edges; track $index) {
                          <line
                            [attr.x1]="edge.x1"
                            [attr.y1]="edge.y1"
                            [attr.x2]="edge.x2"
                            [attr.y2]="edge.y2"
                            stroke="#6366f1"
                            stroke-opacity="0.35"
                            [attr.stroke-width]="edge.width"
                          />
                        }
                        @for (node of graph.nodes; track node.path) {
                          <g class="cursor-pointer" (click)="focusFile.emit(node.path)">
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
                      <p class="text-center text-[11px] text-zinc-600">{{ graph.files }} files</p>
                    </div>
                  }
                </div>
                <p class="mt-3 mb-1 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
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
                    <span
                      class="shrink-0 text-[11px] text-zinc-500 tabular-nums"
                      [title]="
                        'co-changed in ' +
                        pair.support +
                        ' commits · coupled ' +
                        pct(pair.degree) +
                        '% of the time either file changes'
                      "
                    >
                      {{ pair.support }}× · {{ pct(pair.degree) }}%
                    </span>
                  </li>
                }
              </ul>
              @if (more() > 0) {
                <p class="mt-2 text-[11px] text-zinc-600">+{{ more() }} more pairs</p>
              }
              <p class="mt-3 border-t border-zinc-800/70 pt-2 text-[11px] leading-5 text-zinc-600">
                <span class="font-medium text-zinc-500">N× · M%</span> — co-changed in N commits and
                coupled M% of the time either file changes (their share of shared changes). Ranked
                by coupling strength: the % weighted by how much evidence backs it, so a high % from
                only a couple of commits doesn't outrank a well-supported one.
              </p>
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
        } @else if (tab() === 'team') {
          <!-- Team tab -->
          @if (state(); as s) {
            @if (s.status === 'error') {
              <p class="text-sm text-rose-400">{{ s.message }}</p>
            } @else if (s.message) {
              <p class="text-sm text-zinc-500">{{ s.message }}</p>
            } @else if (graph().developers.length) {
              <p class="mb-2 text-xs text-zinc-500">
                Who works with whom — developers are linked when they edit the same files. Click one
                to trace their collaborators; people who share no files are listed below.
              </p>
              <div
                class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-600"
              >
                <span class="tabular-nums">{{ graph().developers.length }} developers</span>
                <span>·</span>
                <span class="tabular-nums">{{ graph().collaborations.length }} ties</span>
                @if (graph().silos.length) {
                  <span>·</span>
                  <span class="tabular-nums">{{ graph().silos.length }} working solo</span>
                }
                @if (moreDevelopers() > 0) {
                  <span class="text-zinc-700">· showing the {{ maxDevelopers }} most active</span>
                }
                @if (graph().collaborations.length) {
                  <span
                    class="flex min-w-0 flex-1 items-center gap-2 text-zinc-500"
                    title="Weight ties toward co-edits that happened close together in time — handoffs and recent pairing — instead of any shared file ever."
                  >
                    <span class="shrink-0">Timing</span>
                    <span class="shrink-0 text-zinc-600">all-time</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="1"
                      [value]="temporalWeightPct()"
                      (input)="onTemporalWeight($event)"
                      class="h-1 min-w-0 flex-1 cursor-pointer accent-indigo-400"
                      aria-label="Temporal weighting"
                    />
                    <span class="shrink-0 text-zinc-600">recent</span>
                    <span class="w-8 shrink-0 text-right tabular-nums text-zinc-400">
                      {{ temporalWeightPct() }}%
                    </span>
                  </span>
                }
              </div>

              @if (teamLayout().nodes.length) {
                <svg
                  class="aspect-[16/9] w-full rounded border border-zinc-800 bg-zinc-900/30"
                  [attr.viewBox]="'0 0 ' + teamW + ' ' + teamH"
                  preserveAspectRatio="xMidYMid meet"
                  role="img"
                >
                  @for (edge of teamLayout().edges; track $index) {
                    <line
                      [attr.x1]="edge.x1"
                      [attr.y1]="edge.y1"
                      [attr.x2]="edge.x2"
                      [attr.y2]="edge.y2"
                      stroke="#6366f1"
                      [attr.stroke-opacity]="edgeOpacity(edge)"
                      [attr.stroke-width]="edge.width"
                    />
                  }
                  @for (node of teamLayout().nodes; track node.id) {
                    <g
                      class="cursor-pointer"
                      [attr.opacity]="nodeOpacity(node)"
                      (click)="toggleDeveloper(node.id)"
                    >
                      <title>{{ nodeTitle(node) }}</title>
                      <circle
                        [attr.cx]="node.x"
                        [attr.cy]="node.y"
                        [attr.r]="node.r"
                        [attr.fill]="node.fill"
                        [attr.stroke]="selected() === node.id ? '#fafafa' : '#18181b'"
                        [attr.stroke-width]="selected() === node.id ? 4 : 2"
                      />
                      <text
                        [attr.x]="node.lx"
                        [attr.y]="node.ly"
                        [attr.text-anchor]="node.anchor"
                        font-size="20"
                        fill="#d4d4d8"
                        class="pointer-events-none font-mono"
                      >
                        {{ node.label }}
                      </text>
                    </g>
                  }
                </svg>
              } @else {
                <p
                  class="rounded border border-zinc-800 bg-zinc-900/30 p-4 text-center text-xs text-zinc-500"
                >
                  No shared-file collaborations in the analysed window — everyone below worked on
                  separate files.
                </p>
              }

              @if (selectedDeveloper(); as dev) {
                <div class="mt-3 rounded border border-zinc-800 bg-zinc-900/40 p-3">
                  <div class="flex items-center gap-2">
                    <span
                      class="size-2.5 shrink-0 rounded-full"
                      [style.background]="fillFor(dev.id)"
                    ></span>
                    <span
                      class="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100"
                      [title]="dev.name"
                      >{{ dev.name }}</span
                    >
                    <span class="shrink-0 text-[11px] text-zinc-500 tabular-nums">
                      {{ dev.commits }} commits · {{ dev.files }} files
                    </span>
                    <button
                      type="button"
                      class="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
                      (click)="clearDeveloper()"
                    >
                      Clear
                    </button>
                  </div>
                  @if (selectedCollaborators().length) {
                    <p
                      class="mt-3 mb-1 text-[11px] font-medium tracking-wide text-zinc-500 uppercase"
                    >
                      Collaborators
                    </p>
                    <ul class="space-y-1">
                      @for (mate of selectedCollaborators(); track mate.id) {
                        <li
                          class="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-white/[0.03]"
                        >
                          <span
                            class="size-2 shrink-0 rounded-full"
                            [style.background]="fillFor(mate.id)"
                          ></span>
                          <button
                            type="button"
                            class="min-w-0 flex-1 truncate text-left text-xs text-zinc-200 underline-offset-2 hover:text-indigo-300 hover:underline"
                            [title]="mate.name"
                            (click)="toggleDeveloper(mate.id)"
                          >
                            {{ mate.name }}
                          </button>
                          <span class="shrink-0 text-[11px] text-zinc-500 tabular-nums">
                            {{ mate.sharedFiles }} shared · {{ tieLabel(mate) }} overlap
                          </span>
                        </li>
                      }
                    </ul>
                  } @else {
                    <p class="mt-2 text-xs text-zinc-500">
                      Works alone in the analysed window — no files shared with anyone else.
                    </p>
                  }
                </div>
              } @else {
                @if (connectors().length) {
                  <p
                    class="mt-3 mb-1 text-[11px] font-medium tracking-wide text-zinc-500 uppercase"
                  >
                    Most connected
                  </p>
                  <ul class="space-y-0.5">
                    @for (dev of connectors(); track dev.id) {
                      <li>
                        <button
                          type="button"
                          class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm transition hover:bg-white/[0.03]"
                          [title]="dev.name"
                          (click)="toggleDeveloper(dev.id)"
                        >
                          <span
                            class="size-2 shrink-0 rounded-full"
                            [style.background]="fillFor(dev.id)"
                          ></span>
                          <span class="min-w-0 flex-1 truncate text-xs text-zinc-200">{{
                            dev.name
                          }}</span>
                          <span class="shrink-0 text-[11px] text-zinc-500 tabular-nums">
                            {{ dev.collaborators }}
                            {{ dev.collaborators === 1 ? 'collaborator' : 'collaborators' }}
                          </span>
                        </button>
                      </li>
                    }
                  </ul>
                }
                @if (graph().silos.length) {
                  <p
                    class="mt-3 mb-1 text-[11px] font-medium tracking-wide text-zinc-500 uppercase"
                  >
                    Working in isolation
                  </p>
                  <div class="flex flex-wrap gap-1.5">
                    @for (id of graph().silos; track id) {
                      <span
                        class="max-w-[12rem] truncate rounded-full border border-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400"
                        [title]="displayName(id)"
                      >
                        {{ displayName(id) }}
                      </span>
                    }
                  </div>
                }
              }
            } @else if (s.status === 'ready') {
              <p class="text-sm text-zinc-500">No authored commits in the analysed history.</p>
            } @else {
              <p class="text-sm text-zinc-500">Mapping the team…</p>
            }
          } @else {
            <p class="mb-3 text-sm text-zinc-500">Analyze the history to map the team.</p>
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
          <!-- Knowledge tab -->
          @if (state(); as s) {
            @if (s.status === 'error') {
              <p class="text-sm text-rose-400">{{ s.message }}</p>
            } @else if (s.message) {
              <p class="text-sm text-zinc-500">{{ s.message }}</p>
            } @else {
              <div class="mb-2 flex items-center gap-3 text-xs text-zinc-500">
                <span>Files at risk of knowledge loss.</span>
                @if (canFilterBySize()) {
                  <span class="flex-1"></span>
                  <span class="text-zinc-600">max size</span>
                  <span
                    class="dual-range relative h-3 w-28"
                    role="group"
                    aria-label="Maximum file size"
                  >
                    <span
                      class="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded bg-zinc-700"
                    ></span>
                    <span
                      class="pointer-events-none absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded bg-indigo-400"
                      [style.right.%]="100 - maxFileSizePct()"
                    ></span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="1"
                      [value]="maxFileSizePct()"
                      (input)="onMaxFileSize($event)"
                      aria-label="Maximum file size"
                    />
                  </span>
                  <span class="w-16 text-right tabular-nums text-zinc-400">{{ sizeLabel() }}</span>
                }
              </div>
              @if (riskList().length) {
                <p class="mb-2 text-xs leading-5 text-zinc-400">
                  <span class="font-medium text-zinc-200">{{ departedKnowledgePct() }}%</span> of
                  authored knowledge has gone quiet.
                  @if (busFactorOne() > 0) {
                    <span class="text-zinc-500"
                      >{{ busFactorOne() }}
                      {{ busFactorOne() === 1 ? 'file is' : 'files are' }} known to only one
                      person{{
                        busFactorOneGone() > 0 ? ' (' + busFactorOneGone() + ' already gone)' : ''
                      }}.</span
                    >
                  }
                </p>
                <svg
                  class="aspect-[16/9] w-full rounded border border-zinc-800 bg-zinc-900/30"
                  [attr.viewBox]="'0 0 ' + treemapW + ' ' + treemapH"
                  preserveAspectRatio="xMidYMid meet"
                >
                  @if (quadrant(); as q) {
                    <line
                      [attr.x1]="q.midX"
                      [attr.y1]="q.y1"
                      [attr.x2]="q.midX"
                      [attr.y2]="q.y0"
                      stroke="#3f3f46"
                      stroke-width="1.5"
                      stroke-dasharray="6 7"
                    />
                    <line
                      [attr.x1]="q.x0"
                      [attr.y1]="q.midY"
                      [attr.x2]="q.x1"
                      [attr.y2]="q.midY"
                      stroke="#3f3f46"
                      stroke-width="1.5"
                      stroke-dasharray="6 7"
                    />
                    <text
                      [attr.x]="q.x1"
                      [attr.y]="q.y0 + 40"
                      text-anchor="end"
                      fill="#71717a"
                      font-size="22"
                    >
                      larger files →
                    </text>
                    <text [attr.x]="q.x0 - 6" [attr.y]="q.y1 - 16" fill="#71717a" font-size="22">
                      ↑ more orphaned
                    </text>
                    <text
                      [attr.x]="q.x1"
                      [attr.y]="q.y1 - 16"
                      text-anchor="end"
                      fill="#a1a1aa"
                      font-size="22"
                    >
                      most at risk ↗
                    </text>
                    @for (p of q.points; track p.file.path) {
                      <g
                        class="cursor-pointer"
                        (click)="selectFromChart(p.file.path)"
                        (mouseenter)="hovered.set(p)"
                        (mouseleave)="hovered.set(null)"
                      >
                        @if (selectedRisk() === p.file.path) {
                          <circle
                            [attr.cx]="p.cx"
                            [attr.cy]="p.cy"
                            [attr.r]="p.r + 7"
                            fill="none"
                            stroke="#818cf8"
                            stroke-width="3"
                          />
                        }
                        <circle
                          [attr.cx]="p.cx"
                          [attr.cy]="p.cy"
                          [attr.r]="p.r"
                          [attr.fill]="p.fill"
                          fill-opacity="0.7"
                          stroke="#18181b"
                          stroke-width="2"
                          class="transition-opacity hover:opacity-100"
                        />
                      </g>
                    }
                    @if (hovered(); as h) {
                      <g class="pointer-events-none">
                        <circle
                          [attr.cx]="h.cx"
                          [attr.cy]="h.cy"
                          [attr.r]="h.r"
                          fill="none"
                          stroke="#fafafa"
                          stroke-width="2.5"
                        />
                        <rect
                          [attr.x]="tipX(h)"
                          [attr.y]="tipY(h)"
                          [attr.width]="quadTipW"
                          [attr.height]="quadTipH"
                          rx="12"
                          fill="#09090b"
                          fill-opacity="0.95"
                          stroke="#3f3f46"
                          stroke-width="1.5"
                        />
                        <text
                          [attr.x]="tipX(h) + 24"
                          [attr.y]="tipY(h) + 46"
                          fill="#fafafa"
                          font-size="26"
                          font-weight="600"
                        >
                          {{ label(h.file.path) }}
                        </text>
                        <text
                          [attr.x]="tipX(h) + 24"
                          [attr.y]="tipY(h) + 86"
                          fill="#a1a1aa"
                          font-size="23"
                        >
                          {{ pct(h.file.orphanedShare) }}% orphaned · {{ sizeOf(h.file.size) }}
                        </text>
                        <text
                          [attr.x]="tipX(h) + 24"
                          [attr.y]="tipY(h) + 124"
                          fill="#a1a1aa"
                          font-size="23"
                        >
                          {{ expertLine(h.file) }}
                        </text>
                      </g>
                    }
                  }
                </svg>
                <div
                  class="mt-3 flex items-center gap-2 px-2 text-[10px] font-medium tracking-wide text-zinc-600 uppercase"
                >
                  <span class="w-12 shrink-0">risk</span>
                  <span class="min-w-0 flex-1">file</span>
                  <span class="shrink-0">expert</span>
                  <span class="w-16 shrink-0 text-right">orphaned</span>
                </div>
                <ul class="mt-1 space-y-0.5">
                  @for (risk of riskList(); track risk.path) {
                    <li
                      [attr.data-risk-path]="risk.path"
                      class="flex items-center gap-1 rounded transition"
                      [style.background-color]="
                        selectedRisk() === risk.path ? 'rgb(99 102 241 / 0.12)' : ''
                      "
                    >
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-sm transition hover:bg-white/[0.03]"
                        [attr.aria-pressed]="selectedRisk() === risk.path"
                        [title]="
                          label(risk.path) +
                          ' — ' +
                          pct(risk.orphanedShare) +
                          '% orphaned · click to highlight on the chart'
                        "
                        (click)="toggleRisk(risk.path)"
                      >
                        <span
                          class="h-1.5 w-12 shrink-0 overflow-hidden rounded-sm bg-zinc-800"
                          title="risk = file size × orphaned share (the list's sort key)"
                        >
                          <span
                            class="block h-full rounded-sm bg-indigo-400"
                            [style.width.%]="riskBar(risk)"
                          ></span>
                        </span>
                        <span class="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">{{
                          label(risk.path)
                        }}</span>
                        @if (risk.primaryExpert; as ex) {
                          <span class="shrink-0 truncate text-[11px] text-zinc-500">{{
                            ex.name
                          }}</span>
                          @if (!ex.active && ex.lastActiveAt) {
                            <span class="shrink-0 text-[11px] text-amber-500/80"
                              >gone {{ when(ex.lastActiveAt) }}</span
                            >
                          }
                        }
                        <span
                          class="flex w-16 shrink-0 items-center justify-end gap-1.5 text-[11px] tabular-nums text-zinc-400"
                        >
                          <span
                            class="size-2 shrink-0 rounded-sm"
                            [style.background]="riskFill(risk)"
                          ></span>
                          {{ pct(risk.orphanedShare) }}%
                        </span>
                      </button>
                      <button
                        type="button"
                        class="shrink-0 rounded p-1.5 text-zinc-500 transition hover:bg-white/[0.06] hover:text-indigo-300"
                        [attr.aria-label]="'Open ' + risk.path"
                        [title]="'Open ' + label(risk.path)"
                        (click)="openFile.emit(risk.path)"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                          <polyline points="15 3 21 3 21 9" />
                          <line x1="10" y1="14" x2="21" y2="3" />
                        </svg>
                      </button>
                    </li>
                  }
                </ul>
                <div class="mt-4 border-t border-zinc-800/70 pt-3">
                  <p class="mb-1.5 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
                    Knowledge holders
                  </p>
                  <ul class="space-y-1.5">
                    @for (a of knowledgeHolders(); track a.name) {
                      <li>
                        <div class="flex items-baseline gap-2 text-xs">
                          <span class="min-w-0 flex-1 truncate text-zinc-200" [title]="a.name">{{
                            a.name
                          }}</span>
                          @if (!a.active && a.lastActiveAt) {
                            <span class="shrink-0 text-[11px] text-amber-500/80"
                              >gone {{ when(a.lastActiveAt) }}</span
                            >
                          }
                          <span class="shrink-0 tabular-nums text-zinc-500"
                            >{{ holderShare(a) }}%</span
                          >
                        </div>
                        <div class="mt-0.5 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                          <div
                            class="h-full rounded-full"
                            [style.width.%]="holderShare(a)"
                            [style.background]="holderFill(a)"
                          ></div>
                        </div>
                      </li>
                    }
                  </ul>
                </div>
                <dl
                  class="mt-3 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 border-t border-zinc-800/70 pt-2 text-[11px] text-zinc-600"
                >
                  <dt class="font-medium text-zinc-500">dot</dt>
                  <dd>
                    a file — right = larger, up = more orphaned; size &amp; colour = risk (size ×
                    orphaned), so the top-right is most at risk
                  </dd>
                  <dt class="font-medium text-zinc-500">orphaned</dt>
                  <dd>share of recent authorship held by contributors who've gone quiet</dd>
                  <dt class="font-medium text-zinc-500">holders</dt>
                  <dd>contributors by authored-knowledge share; redder = more gone</dd>
                  <dt class="font-medium text-zinc-500">select</dt>
                  <dd>
                    click a dot or a list row to highlight it in the other; the ↗ icon opens the
                    file
                  </dd>
                </dl>
                <p class="mt-2 text-[11px] leading-5 text-zinc-600">
                  <span class="font-medium text-zinc-500">How orphaned is calculated.</span>
                  Each contributor's recent commits to a file — weighted by recency, with a 90-day
                  half-life so a commit a quarter ago counts half as much as one today — give them a
                  share of its know-how. Each contributor also carries a departure factor that ramps
                  from 0 to 1 the longer they stay silent across the whole repo (120-day half-life —
                  about ½ after four quiet months, never a sudden cliff). A file's orphaned share is
                  the sum over its contributors of share × departure: the fraction of recent
                  authorship now held by people who've gone quiet, independent of file size.
                  Example: someone who wrote 70% of a file and left ~4 months ago, with the other
                  30% fresh, reads ≈ 35% orphaned.
                </p>
                @if (s.knowledge.partial) {
                  <p class="mt-2 text-[11px] text-zinc-600">
                    From the analysed commits only — Load all commits for a complete turnover
                    picture.
                  </p>
                }
              } @else if (s.status === 'ready') {
                @if (anyRisk()) {
                  <p class="text-sm text-zinc-500">No files within the selected size range.</p>
                } @else {
                  <p class="text-sm text-zinc-500">No authored activity in the analysed commits.</p>
                  @if (s.knowledge.partial) {
                    <p class="mt-2 text-[11px] text-zinc-600">
                      From the analysed commits only — Load all commits for a complete turnover
                      picture.
                    </p>
                  }
                }
              } @else {
                <p class="text-sm text-zinc-500">Mapping knowledge…</p>
              }
            }
          } @else {
            <p class="mb-3 text-sm text-zinc-500">Analyze the history to map knowledge risk.</p>
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
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

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
  protected readonly teamW = TEAM_W;
  protected readonly teamH = TEAM_H;
  protected readonly maxDevelopers = MAX_DEVELOPERS;
  protected readonly quadTipW = QUAD_TIP_W;
  protected readonly quadTipH = QUAD_TIP_H;
  /** The risk-quadrant bubble under the pointer, or null — drives the tooltip. */
  protected readonly hovered = signal<QuadrantPoint | null>(null);
  /** File selected in the Knowledge list/quadrant — cross-highlights both, or null. */
  protected readonly selectedRisk = signal<string | null>(null);
  protected readonly tab = signal<'hotspots' | 'coupling' | 'team' | 'knowledge'>('hotspots');
  protected readonly floor = CLUSTER_SIZE_FLOOR;
  protected readonly ceil = CLUSTER_SIZE_CEIL;
  protected readonly minClusterSize = signal(DEFAULT_MIN_CLUSTER_FILES);
  protected readonly maxClusterSize = signal(DEFAULT_MAX_CLUSTER_FILES);
  /** The developer the team graph is focused on, or null. */
  private readonly selectedDev = signal<string | null>(null);
  /** Slider 0..1: blend ties from all-time (0) toward recent collaboration (1). */
  protected readonly temporalWeight = signal(DEFAULT_TEMPORAL_WEIGHT);
  protected readonly temporalWeightPct = computed(() => Math.round(this.temporalWeight() * 100));
  /** Treemap size filter as a 0–100 slider position (100 = no limit). */
  protected readonly maxFileSizePct = signal(100);

  /** The selected band as track percentages, for the slider's filled segment. */
  protected readonly rangePercent = computed(() => {
    const span = this.ceil - this.floor || 1;
    return {
      left: ((this.minClusterSize() - this.floor) / span) * 100,
      right: ((this.ceil - this.maxClusterSize()) / span) * 100,
    };
  });

  /** Largest analysed file size (bytes) — the top of the size-filter slider. */
  protected readonly sizeCeil = computed(() => {
    const s = this.state();
    let max = 0;
    for (const hot of s?.hotspots ?? []) max = Math.max(max, hot.size);
    for (const risk of s?.knowledge.files ?? []) max = Math.max(max, risk.size);
    return max;
  });

  /** Only worth offering the size filter when there is a spread to filter. */
  protected readonly canFilterBySize = computed(() => {
    const s = this.state();
    const files = (s?.hotspots.length ?? 0) + (s?.knowledge.files.length ?? 0);
    return files > 1 && this.sizeCeil() > 0;
  });

  /**
   * Selected upper size bound, in bytes. The slider position maps on a log2
   * scale (file sizes span orders of magnitude, so a linear handle would bunch
   * everything at the low end). 100 — or a result too small to show the control
   * ({@link canFilterBySize}) — means "no limit", so a stale value can't keep
   * silently filtering once the slider is hidden.
   */
  protected readonly maxFileBytes = computed(() => {
    const pct = this.maxFileSizePct();
    if (pct >= 100 || !this.canFilterBySize()) return Number.POSITIVE_INFINITY;
    return 2 ** (Math.log2(Math.max(this.sizeCeil(), 1)) * (pct / 100));
  });

  /** File counts before the size filter, for the empty-state copy. */
  protected readonly anyHotspots = computed(() => (this.state()?.hotspots.length ?? 0) > 0);
  protected readonly anyRisk = computed(() => (this.state()?.knowledge.files.length ?? 0) > 0);

  protected readonly pairs = computed(() => (this.state()?.result.pairs ?? []).slice(0, MAX_PAIRS));
  protected readonly more = computed(() =>
    Math.max(0, (this.state()?.result.pairs.length ?? 0) - MAX_PAIRS),
  );
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
  protected readonly clusterGraphs = computed(() => this.clusters().map((c) => this.layout(c)));

  private readonly hotspots = computed(() => {
    const max = this.maxFileBytes();
    return (this.state()?.hotspots ?? []).filter((hot) => hot.size <= max).slice(0, MAX_HOTSPOTS);
  });
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

  private readonly knowledgeFiles = computed(() => {
    const max = this.maxFileBytes();
    return (this.state()?.knowledge.files ?? [])
      .filter((risk) => risk.size <= max)
      .slice(0, MAX_RISK);
  });
  protected readonly riskList = computed(() => this.knowledgeFiles());
  /** Largest riskScore among the files shown — scales the importance bars. */
  protected readonly maxRisk = computed(() =>
    this.riskList().reduce((max, risk) => Math.max(max, risk.riskScore), 0),
  );
  // Risk quadrant: x = file size (log), y = orphaned share, bubble area = riskScore.
  protected readonly quadrant = computed<Quadrant>(() => {
    const files = this.riskList();
    const x0 = 64;
    const x1 = TREEMAP_W - 48;
    const y0 = TREEMAP_H - 64;
    const y1 = 48;
    const logs = files.map((f) => Math.log(Math.max(f.size, 1)));
    const loMin = logs.length ? Math.min(...logs) : 0;
    const span = (logs.length ? Math.max(...logs) : 1) - loMin || 1;
    const maxRisk = this.maxRisk() || 1;
    const xOf = (size: number): number =>
      x0 + ((Math.log(Math.max(size, 1)) - loMin) / span) * (x1 - x0);
    const yOf = (orphaned: number): number => y0 + orphaned * (y1 - y0);
    return {
      points: files.map((f) => ({
        file: f,
        cx: xOf(f.size),
        cy: yOf(f.orphanedShare),
        r: 10 + Math.sqrt(f.riskScore / maxRisk) * 40,
        fill: heatColor(f.orphanedShare, RISK_THRESHOLDS),
      })),
      midX: xOf(median(files.map((f) => Math.max(f.size, 1)))),
      midY: yOf(median(files.map((f) => f.orphanedShare))),
      x0,
      x1,
      y0,
      y1,
    };
  });

  /** Contributors holding the most authored knowledge (departed ones flagged). */
  protected readonly knowledgeHolders = computed(() =>
    (this.state()?.knowledge.authors ?? []).slice(0, MAX_HOLDERS),
  );
  protected readonly totalKnowledge = computed(
    () => (this.state()?.knowledge.authors ?? []).reduce((sum, a) => sum + a.knowledge, 0) || 1,
  );
  /** Share of authored knowledge held by contributors who've gone quiet, 0–100. */
  protected readonly departedKnowledgePct = computed(() => {
    const authors = this.state()?.knowledge.authors ?? [];
    let total = 0;
    let gone = 0;
    for (const a of authors) {
      total += a.knowledge;
      gone += a.knowledge * a.departed;
    }
    return total > 0 ? Math.round((gone / total) * 100) : 0;
  });
  /** Files only one contributor knows — a single point of failure. */
  protected readonly busFactorOne = computed(
    () => (this.state()?.knowledge.files ?? []).filter((f) => f.busFactor === 1).length,
  );
  /** …of those, the ones whose sole owner has already gone quiet. */
  protected readonly busFactorOneGone = computed(
    () =>
      (this.state()?.knowledge.files ?? []).filter(
        (f) => f.busFactor === 1 && f.primaryExpert && !f.primaryExpert.active,
      ).length,
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
    for (const risk of this.knowledgeFiles()) paths.add(risk.path);
    for (const cluster of this.clusters()) for (const file of cluster.files) paths.add(file);
    return disambiguateLabels(paths);
  });

  /** The developer collaboration graph from the overview walk. */
  protected readonly graph = computed<TeamGraph>(() => this.state()?.teamGraph ?? EMPTY_TEAM_GRAPH);
  /** Developers with ≥ 1 collaborator — the only ones drawn in the graph. */
  private readonly linkedDevelopers = computed<Developer[]>(() =>
    this.graph().developers.filter((d) => d.collaborators > 0),
  );
  /** Linked developers beyond the render cap (shown only as a count). */
  protected readonly moreDevelopers = computed(() =>
    Math.max(0, this.linkedDevelopers().length - MAX_DEVELOPERS),
  );

  /**
   * The selected developer, re-validated against the current graph so a stale
   * selection (after a re-analyze that dropped them) clears itself.
   */
  protected readonly selectedDeveloper = computed<Developer | null>(() => {
    const id = this.selectedDev();
    return id ? (this.graph().developers.find((d) => d.id === id) ?? null) : null;
  });
  /** Identity of the selected developer, or null. */
  protected readonly selected = computed(() => this.selectedDeveloper()?.id ?? null);

  protected readonly selectedCollaborators = computed<Collaborator[]>(() => {
    const id = this.selected();
    return id ? collaboratorsOf(this.graph(), id, MAX_COLLABORATORS, this.temporalWeight()) : [];
  });

  /** Developers with the most collaborators — the people who bridge the work. */
  protected readonly connectors = computed<Developer[]>(() =>
    [...this.graph().developers]
      .filter((d) => d.collaborators > 0)
      .sort(
        (a, b) =>
          b.collaborators - a.collaborators ||
          b.commits - a.commits ||
          a.name.localeCompare(b.name),
      )
      .slice(0, MAX_CONNECTORS),
  );

  /** Display name per developer identity — for the silo chips and lookups. */
  private readonly nameById = computed<ReadonlyMap<string, string>>(
    () => new Map(this.graph().developers.map((d) => [d.id, d.name])),
  );

  // The layout is selection-aware: it always draws the selected developer and
  // their collaborators (even past the caps), so clicking anyone — including a
  // silo or a less-central developer outside the top slice — lights up a real
  // neighbourhood instead of dimming the graph to nothing. It also depends on
  // the temporal weight, so dragging the slider re-shapes the graph live.
  protected readonly teamLayout = computed<TeamLayout>(() =>
    this.layoutTeam(this.graph(), this.selected(), this.temporalWeight()),
  );

  /** Fill per rendered developer identity, for the swatches in the lists. */
  private readonly fillById = computed<ReadonlyMap<string, string>>(() => {
    const map = new Map<string, string>();
    for (const node of this.teamLayout().nodes) map.set(node.id, node.fill);
    return map;
  });

  /** The selected developer plus all their collaborators — the lit-up subgraph. */
  private readonly highlighted = computed<ReadonlySet<string>>(() => {
    const id = this.selected();
    if (!id) return new Set();
    const set = new Set<string>([id]);
    for (const mate of collaboratorsOf(this.graph(), id)) set.add(mate.id);
    return set;
  });

  constructor() {
    // Applying a file filter is a coupling action — show that tab.
    effect(() => {
      if (this.focus()) this.tab.set('coupling');
    });
  }

  private layout(cluster: CoChangeCluster): ClusterGraph {
    const cx = CLUSTER_W / 2;
    const cy = CLUSTER_H / 2 + 6;
    const radius = 78;
    const n = cluster.files.length;
    const pos = new Map<string, { x: number; y: number }>();
    cluster.files.forEach((path, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2 + CLUSTER_ROTATION;
      pos.set(path, {
        x: n === 1 ? cx : cx + radius * Math.cos(angle),
        y: n === 1 ? cy : cy + radius * Math.sin(angle),
      });
    });
    const nodes = cluster.files.map((path) => ({
      path,
      label: this.label(path),
      ...pos.get(path)!,
    }));
    const edges = cluster.edges.map((edge) => {
      const a = pos.get(edge.a)!;
      const b = pos.get(edge.b)!;
      return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, width: 1 + edge.degree * 4 };
    });
    return { files: n, nodes, edges };
  }

  /**
   * Positions the **linked** developers with a force-directed simulation —
   * people who share no files are left out (listed beneath the graph instead of
   * floating as unconnected dots). Collaborators attract and everyone repels,
   * so teams clump together and whoever bridges them settles between, then the
   * result is scaled to fit the box. Disc size scales with commit count and
   * colour marks the connected component.
   *
   * Selection-aware: the rendered set is the most-active slice plus, when a
   * developer is selected, that developer and their collaborators — so drilling
   * into someone past the cap still shows a real neighbourhood rather than
   * dimming the graph to nothing. The selected developer's own ties are drawn
   * even past the global edge cap.
   */
  private layoutTeam(graph: TeamGraph, selectedId: string | null, weight: number): TeamLayout {
    // Only people with collaboration links belong in the graph; the rest are
    // listed beneath it, so they never appear as unconnected dots.
    const linked = graph.developers.filter((d) => d.collaborators > 0);
    if (linked.length === 0) return { nodes: [], edges: [] };

    const renderedIds = new Set(linked.slice(0, MAX_DEVELOPERS).map((d) => d.id));
    if (selectedId) {
      // Force the selection in only when it has links (a silo is never drawn);
      // its collaborators are linked by definition. Pass the slider weight so
      // the rendered neighbourhood matches the collaborator panel's order.
      if (graph.developers.find((d) => d.id === selectedId)?.collaborators) {
        renderedIds.add(selectedId);
      }
      for (const mate of collaboratorsOf(graph, selectedId, MAX_DEVELOPERS, weight))
        renderedIds.add(mate.id);
    }
    const rendered = graph.developers.filter((d) => renderedIds.has(d.id));

    const componentOf = new Map<string, number>();
    graph.components.forEach((members, index) => {
      for (const id of members) componentOf.set(id, index);
    });

    const order = [...rendered].sort(
      (a, b) =>
        (componentOf.get(a.id) ?? 0) - (componentOf.get(b.id) ?? 0) ||
        b.collaborators - a.collaborators ||
        b.commits - a.commits ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );

    const maxCommits = Math.max(...order.map((d) => d.commits), 1);

    // Tie strength is blended toward recent collaboration by the slider weight;
    // it drives the layout pull, the drawn edges, and which survive the cap.
    const strengthOf = (edge: Collaboration): number =>
      blendStrength(edge.strength, edge.temporalStrength, weight);

    // Run the simulation over the real ties (all of them, not just the drawn
    // subset) for a faithful shape, then scale the result to fit the box.
    const renderedSet = new Set(order.map((d) => d.id));
    const simEdges: ForceEdge[] = graph.collaborations
      .filter((edge) => renderedSet.has(edge.a) && renderedSet.has(edge.b))
      .map((edge) => ({ a: edge.a, b: edge.b, weight: strengthOf(edge) }));
    const raw = forceLayout(
      order.map((d) => d.id),
      simEdges,
      { attraction: TEAM_ATTRACTION },
    );
    const place = fitToBox(raw.values(), TEAM_W, TEAM_H, TEAM_MARGIN);

    const pos = new Map<string, Point>();
    const nodes: TeamNode[] = order.map((dev) => {
      const point = place(raw.get(dev.id)!);
      pos.set(dev.id, point);
      const r = 6 + 12 * Math.sqrt(dev.commits / maxCommits);
      const component = componentOf.get(dev.id) ?? 0;
      return {
        id: dev.id,
        name: dev.name,
        label: shortName(dev.name),
        x: point.x,
        y: point.y,
        r,
        // The label sits centred just below each disc.
        lx: point.x,
        ly: point.y + r + 22,
        anchor: 'middle',
        fill: TEAM_COLORS[component % TEAM_COLORS.length],
        commits: dev.commits,
        files: dev.files,
        collaborators: dev.collaborators,
      };
    });

    // Draw the selected developer's ties first so they survive the cap, then
    // fill with the strongest remaining ties (by blended strength) between
    // rendered nodes. Every rendered tie keeps a (faint) line — a faded tie is
    // de-emphasised by opacity/width, never removed.
    const incident: TeamEdge[] = [];
    const rest: TeamEdge[] = [];
    for (const edge of graph.collaborations) {
      const a = pos.get(edge.a);
      const b = pos.get(edge.b);
      if (!a || !b) continue; // an endpoint sits beyond the rendered set
      const strength = strengthOf(edge);
      const line: TeamEdge = {
        a: edge.a,
        b: edge.b,
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        width: 1.2 + 5 * strength,
        strength,
      };
      if (selectedId && (edge.a === selectedId || edge.b === selectedId)) incident.push(line);
      else rest.push(line);
    }
    rest.sort((x, y) => y.strength - x.strength);
    const edges = incident;
    for (const line of rest) {
      if (edges.length >= MAX_TEAM_EDGES) break;
      edges.push(line);
    }
    return { nodes, edges };
  }

  /** Dim every node outside the selected developer's neighbourhood. */
  protected nodeOpacity(node: TeamNode): number {
    if (!this.selected()) return 1;
    return this.highlighted().has(node.id) ? 1 : 0.2;
  }

  /** A selection lights up its own ties; otherwise opacity tracks strength. */
  protected edgeOpacity(edge: TeamEdge): number {
    const id = this.selected();
    if (id) return edge.a === id || edge.b === id ? 0.85 : 0.08;
    // Every tie stays visible; strength only varies how strongly it reads.
    return 0.32 + 0.45 * edge.strength;
  }

  protected nodeTitle(node: TeamNode): string {
    const mates =
      node.collaborators === 1 ? '1 collaborator' : `${node.collaborators} collaborators`;
    return `${node.name} — ${node.commits} commits, ${node.files} files, ${mates}`;
  }

  protected fillFor(id: string): string {
    return this.fillById().get(id) ?? SILO_FILL;
  }

  /** The display name for a developer identity — for the silo chips. */
  protected displayName(id: string): string {
    return this.nameById().get(id) ?? id;
  }

  /**
   * A collaborator's tie strength as a label, blended at the active slider
   * weight: `13%`, or `<1%` for a real-but-tiny tie (so a shared-file
   * collaboration never reads as a flat `0%`), or `0%` only when truly nil.
   */
  protected tieLabel(mate: Collaborator): string {
    const strength = blendStrength(mate.strength, mate.temporalStrength, this.temporalWeight());
    const pct = Math.round(strength * 100);
    if (pct > 0) return `${pct}%`;
    return strength > 0 ? '<1%' : '0%';
  }

  /** Selects a developer, or clears the selection when they are clicked again. */
  protected toggleDeveloper(id: string): void {
    this.selectedDev.update((current) => (current === id ? null : id));
  }

  protected clearDeveloper(): void {
    this.selectedDev.set(null);
  }

  protected onTemporalWeight(event: Event): void {
    this.temporalWeight.set(Number((event.target as HTMLInputElement).value) / 100);
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

  protected fill(hot: Hotspot): string {
    return heatColor(hot.metric.score, HEAT_THRESHOLDS);
  }

  protected riskFill(risk: KnowledgeRisk): string {
    return heatColor(risk.orphanedShare, RISK_THRESHOLDS);
  }

  /** Bar colour for a knowledge holder: heat by how departed they are. */
  protected holderFill(author: AuthorPresence): string {
    return heatColor(author.departed, RISK_THRESHOLDS);
  }

  /** A holder's share of the repo's authored knowledge, 0–100. */
  protected holderShare(author: AuthorPresence): number {
    return Math.round((author.knowledge / this.totalKnowledge()) * 100);
  }

  /**
   * Importance-bar width (%) for a row: the file's riskScore (size ×
   * orphanedShare — the list's sort key) relative to the riskiest file shown, so
   * the bars shrink down the list and the ordering is visible. A small floor
   * keeps a non-zero risk from rendering as nothing.
   */
  protected riskBar(risk: KnowledgeRisk): number {
    const max = this.maxRisk();
    if (max <= 0 || risk.riskScore <= 0) return 0;
    return Math.max(3, (risk.riskScore / max) * 100);
  }

  /** Toggle the cross-highlight selection for a file (click the same one again to clear). */
  protected toggleRisk(path: string): void {
    this.selectedRisk.update((cur) => (cur === path ? null : path));
  }

  /** Select from a quadrant bubble, then bring its list row into view. */
  protected selectFromChart(path: string): void {
    this.toggleRisk(path);
    if (this.selectedRisk() === path) this.scrollRowIntoView(path);
  }

  /** Best-effort scroll of a file's list row into view (no-op without layout, e.g. jsdom). */
  private scrollRowIntoView(path: string): void {
    const rows = this.host.nativeElement.querySelectorAll<HTMLElement>('[data-risk-path]');
    const row = Array.from(rows).find((el) => el.dataset['riskPath'] === path);
    try {
      row?.scrollIntoView({ block: 'nearest' });
    } catch {
      // Layout-less environments don't implement scrollIntoView; the highlight still applies.
    }
  }

  /** Left edge of the hover tooltip — placed beside the bubble, flipped/clamped to stay in view. */
  protected tipX(p: QuadrantPoint): number {
    const right = p.cx + p.r + 16;
    if (right + QUAD_TIP_W <= TREEMAP_W) return right;
    return Math.max(0, p.cx - p.r - 16 - QUAD_TIP_W);
  }

  /** Top edge of the hover tooltip — centred on the bubble, clamped to stay in view. */
  protected tipY(p: QuadrantPoint): number {
    return Math.max(0, Math.min(TREEMAP_H - QUAD_TIP_H, p.cy - QUAD_TIP_H / 2));
  }

  /** Human-readable size for the hover tooltip. */
  protected sizeOf(bytes: number): string {
    return formatBytes(bytes);
  }

  /** "bus factor N · Expert (gone)" summary line for the hover tooltip. */
  protected expertLine(file: KnowledgeRisk): string {
    const bus = `bus factor ${file.busFactor}`;
    const ex = file.primaryExpert;
    return ex ? `${bus} · ${ex.name}${ex.active ? '' : ' (gone)'}` : bus;
  }

  protected onMaxFileSize(event: Event): void {
    this.maxFileSizePct.set(Number((event.target as HTMLInputElement).value));
  }

  /** Readout for the size filter: the upper bound, or "All sizes" when off. */
  protected sizeLabel(): string {
    return this.maxFileSizePct() >= 100 ? 'All sizes' : '≤ ' + formatBytes(this.maxFileBytes());
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

/**
 * A compact node label for a developer: the local part of an email or the
 * first name, capped so it doesn't crowd the graph (the full name is in the
 * node's tooltip and the lists).
 */
function shortName(name: string): string {
  const at = name.indexOf('@');
  const base = (at > 0 ? name.slice(0, at) : name).trim();
  const first = base.split(/\s+/)[0] || base;
  return first.length > 14 ? first.slice(0, 13) + '…' : first;
}

/**
 * Builds a mapper that scales the simulation's arbitrary coordinates uniformly
 * into a `width`×`height` box (centred, with `margin` to spare for discs and
 * labels), preserving the layout's aspect.
 */
function fitToBox(
  points: Iterable<Point>,
  width: number,
  height: number,
  margin: number,
): (p: Point) => Point {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const scale = Math.min((width - 2 * margin) / spanX, (height - 2 * margin) / spanY);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  return (p) => ({ x: width / 2 + (p.x - midX) * scale, y: height / 2 + (p.y - midY) * scale });
}
