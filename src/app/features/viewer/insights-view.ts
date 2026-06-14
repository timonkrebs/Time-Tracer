import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import { CoChangeState } from '../../core/store/repo-store';
import { relatedFiles } from '../../core/util/co-change';
import { Hotspot, heatLevel } from '../../core/util/hotspots';
import { disambiguateLabels } from '../../core/util/path-label';
import { relativeTime } from '../../core/util/relative-time';
import { TreemapTile, squarify } from '../../core/util/treemap';

/** Repo-wide pairs rendered at once. */
const MAX_PAIRS = 60;
/** Coupled files listed for a focused file. */
const MAX_RELATED = 100;
/** Hottest files placed in the treemap / listed. */
const MAX_HOTSPOTS = 45;
/** Treemap coordinate space (16:9, scaled uniformly to fill its box). */
const TREEMAP_W = 1600;
const TREEMAP_H = 900;
/** Cold → hot fills, indexed by heat level. */
const HEAT_FILLS = ['#3f3f46', '#854d0e', '#b45309', '#ea580c', '#ef4444'];

/**
 * Repository Insights — a metrics view over recent history.
 *
 * **Hotspots**: files ranked by recency-weighted churn (`hotspots.ts`), as a
 * size-by-LOC, colour-by-heat treemap and a list. **Change coupling**: files
 * that tend to change in the same commit. Both come from one capped commit
 * walk; pick a file in the tree to focus coupling on its full history.
 */
@Component({
  selector: 'app-insights-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex h-full min-h-0 flex-col bg-zinc-950' },
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
      @if (state()) {
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
      @if (state(); as s) {
        @if (s.status === 'error') {
          <p class="text-sm text-rose-400">{{ s.message }}</p>
          <button
            type="button"
            class="mt-3 rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-400"
            (click)="analyze.emit()"
          >
            Try again
          </button>
        } @else if (s.focus; as focus) {
          <div class="mb-3 flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate text-sm text-zinc-200">
              Changes with <span class="font-mono" [title]="focus">{{ label(focus) }}</span>
            </span>
            <button
              type="button"
              class="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
              (click)="openFile.emit(focus)"
            >
              Open file
            </button>
          </div>
          <p class="mb-3 text-xs text-zinc-500">
            @if (s.status === 'computing') {
              Walking this file's history… {{ s.scanned }} commits
            } @else if (s.message) {
              {{ s.message }}
            } @else {
              From all {{ s.result.commitsUsed }}
              {{ s.result.commitsUsed === 1 ? 'commit' : 'commits' }} that touched it — click a file
              to focus on it instead.
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
          } @else if (s.status === 'ready' && !s.message) {
            <p class="text-sm text-zinc-500">
              {{ label(focus) }} hasn't changed alongside other files in its history.
            </p>
          }
        } @else {
          <!-- Repo-wide: Hotspots / Coupling tabs. -->
          @if (s.message) {
            <p class="text-sm text-zinc-500">{{ s.message }}</p>
          } @else {
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
              <span class="text-zinc-600">
                @if (s.status === 'computing') {
                  {{ s.scanned }}/{{ s.target }} commits…
                } @else {
                  {{ s.result.commitsUsed }} commits
                }
              </span>
            </div>

            @if (tab() === 'hotspots') {
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
            } @else {
              @if (pairs().length) {
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
              } @else if (s.status === 'ready') {
                <p class="text-sm text-zinc-500">
                  No files changed together often enough in the last {{ s.result.commitsUsed }}
                  commits.
                </p>
              } @else {
                <p class="text-sm text-zinc-500">Finding coupling…</p>
              }
            }
          }
        }
      } @else {
        <div class="mx-auto max-w-md py-10 text-center">
          <h3 class="text-sm font-medium text-zinc-200">Repository insights</h3>
          <p class="mt-2 text-xs leading-5 text-zinc-500">
            Analyze the last {{ commitCap() }} commits for **hotspots** (files churning the most,
            recently) and **change coupling** (files that change together) — or pick a file in the
            tree for its own full-history coupling. One request per commit, so on the anonymous API
            budget add a token first.
          </p>
          <button
            type="button"
            class="mt-4 rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-400"
            (click)="analyze.emit()"
          >
            Analyze recent history
          </button>
        </div>
      }
    </div>
  `,
})
export class InsightsView {
  readonly state = input<CoChangeState | null>(null);
  readonly commitCap = input<number>(75);

  readonly analyze = output<void>();
  readonly clear = output<void>();
  /** Drill the coupling analysis onto a file (its full history). */
  readonly focusFile = output<string>();
  /** Leave Insights and open a file. */
  readonly openFile = output<string>();

  protected readonly treemapW = TREEMAP_W;
  protected readonly treemapH = TREEMAP_H;
  protected readonly tab = signal<'hotspots' | 'coupling'>('hotspots');

  protected readonly pairs = computed(() => (this.state()?.result.pairs ?? []).slice(0, MAX_PAIRS));
  protected readonly more = computed(() =>
    Math.max(0, (this.state()?.result.pairs.length ?? 0) - MAX_PAIRS),
  );
  protected readonly focusRelated = computed(() => {
    const state = this.state();
    return state?.focus ? relatedFiles(state.result, state.focus, MAX_RELATED) : [];
  });

  private readonly hotspots = computed(() => (this.state()?.hotspots ?? []).slice(0, MAX_HOTSPOTS));
  protected readonly list = computed(() => this.hotspots());
  protected readonly tiles = computed<TreemapTile<Hotspot>[]>(() =>
    squarify(
      this.hotspots().map((hot) => ({ weight: hot.size, value: hot })),
      TREEMAP_W,
      TREEMAP_H,
    ),
  );

  /** Display labels for every file shown, full-path when basenames collide. */
  private readonly labels = computed(() => {
    const paths = new Set<string>();
    const focus = this.state()?.focus;
    if (focus) paths.add(focus);
    for (const rel of this.focusRelated()) paths.add(rel.path);
    for (const pair of this.pairs()) {
      paths.add(pair.a);
      paths.add(pair.b);
    }
    for (const hot of this.hotspots()) paths.add(hot.path);
    return disambiguateLabels(paths);
  });

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
