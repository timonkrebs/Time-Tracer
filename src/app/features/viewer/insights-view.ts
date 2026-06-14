import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { CoChangeState } from '../../core/store/repo-store';

/** Coupled pairs rendered at once. */
const MAX_PAIRS = 60;

/**
 * Repository Insights — starts with **change coupling**: files that tend to
 * change in the same commit ("touch auth.ts, you usually touch session.ts").
 * The analysis walks recent commits on demand (request-heavy, so opt-in), and
 * streams as it goes. Clicking a file opens it.
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
      <span class="text-xs text-zinc-500">· files that change together</span>
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
        } @else {
          <p class="mb-3 text-xs text-zinc-500">
            @if (s.status === 'computing') {
              Walking commits… {{ s.scanned }}/{{ commitCap() }}
            } @else {
              From the last {{ s.result.commitsUsed }}
              {{ s.result.commitsUsed === 1 ? 'commit' : 'commits' }}. Pairs that changed together
              most often — click a file to open it.
            }
          </p>

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
                      (click)="openFile.emit(pair.a)"
                    >
                      {{ name(pair.a) }}
                    </button>
                    <span class="shrink-0 text-zinc-600">↔</span>
                    <button
                      type="button"
                      class="truncate font-mono text-xs text-zinc-200 underline-offset-2 hover:text-indigo-300 hover:underline"
                      [title]="pair.b"
                      (click)="openFile.emit(pair.b)"
                    >
                      {{ name(pair.b) }}
                    </button>
                  </span>
                  <span
                    class="shrink-0 text-[11px] text-zinc-500 tabular-nums"
                    [title]="
                      'Changed together in ' +
                      pair.support +
                      ' commits — ' +
                      pct(pair.degree) +
                      '% coupling'
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
          } @else if (s.status === 'ready') {
            <p class="text-sm text-zinc-500">
              No files changed together often enough in the last {{ s.result.commitsUsed }} commits.
            </p>
          }
        }
      } @else {
        <div class="mx-auto max-w-md py-10 text-center">
          <h3 class="text-sm font-medium text-zinc-200">Find files that change together</h3>
          <p class="mt-2 text-xs leading-5 text-zinc-500">
            Time Tracer walks the last {{ commitCap() }} commits and looks at which files keep
            changing in the same commit — surfacing hidden coupling (“touch this, you usually touch
            that”). It fetches one request per commit, so on the anonymous API budget add a token
            first.
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
  readonly openFile = output<string>();

  protected readonly pairs = computed(() => (this.state()?.result.pairs ?? []).slice(0, MAX_PAIRS));
  protected readonly more = computed(() =>
    Math.max(0, (this.state()?.result.pairs.length ?? 0) - MAX_PAIRS),
  );

  protected pct(degree: number): number {
    return Math.round(degree * 100);
  }

  protected name(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
  }
}
