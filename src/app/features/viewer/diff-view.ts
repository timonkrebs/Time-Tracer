import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { BlameState, DiffState } from '../../core/store/repo-store';
import { LineRange, hunkChangeRanges } from '../../core/util/line-range';
import { shortSha } from '../../core/util/relative-time';
import { AnnotationCell, buildAnnotationCells } from './blame-annotation';

/** Line height of diff rows (`leading-6`), used for scroll/highlight maths. */
const LINE_HEIGHT_PX = 24;

interface DiffRow {
  readonly type: 'hunk' | 'add' | 'remove' | 'ctx';
  readonly oldNo: string;
  readonly newNo: string;
  readonly marker: string;
  readonly text: string;
  readonly newLine?: number;
  readonly traceRange?: LineRange;
  /** First old/new-side lines of the hunk; only set for hunk header rows. */
  readonly hunkOldStart?: number;
  readonly hunkNewStart?: number;
}

interface SplitCell {
  readonly lineNo: number;
  readonly text: string;
  readonly changed: boolean;
}

interface SplitRow {
  readonly type: 'hunk' | 'line';
  readonly header?: string;
  readonly hunkOldStart?: number;
  readonly hunkNewStart?: number;
  readonly traceRange?: LineRange;
  readonly left: SplitCell | null;
  readonly right: SplitCell | null;
}

/**
 * What one commit changed in the selected file. Two renderings:
 *
 * - Unified diff: dual line-number gutter, +/− markers, hunk headers.
 * - Split mode (blame on): the parent version on the left and the commit's
 *   version on the right, each with its own blame gutter — annotated time
 *   travel, side by side.
 *
 * Each hunk offers "◂ Before" — jump to the parent version, annotated, at
 * the hunk's old position — the per-hunk step of the recursive time travel.
 * "Trace" filters history to one change run or a selected new-side line range.
 */
@Component({
  selector: 'app-diff-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    @if (state(); as s) {
      <header
        class="flex h-10 shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-900/60 px-4"
      >
        <span class="truncate font-mono text-xs text-zinc-300">{{ path() }}</span>
        @if (s.status === 'ready') {
          <span class="shrink-0 font-mono text-[11px]">
            <span class="text-emerald-400">+{{ s.diff.added }}</span>
            <span class="ml-1 text-rose-400">−{{ s.diff.removed }}</span>
          </span>
          @if (comparingPath(); as cmp) {
            <span
              class="flex min-w-0 shrink items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-200"
            >
              <span class="truncate" [title]="'Comparing against ' + cmp">vs {{ cmp }}</span>
              <button
                type="button"
                class="shrink-0 rounded p-0.5 text-amber-200/70 transition hover:bg-white/10 hover:text-amber-100"
                (click)="comparisonClear.emit()"
                aria-label="Stop comparing"
                title="Back to this commit's own changes"
              >
                <svg
                  class="size-3"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </span>
          } @else {
            <span class="hidden shrink-0 text-[11px] text-zinc-600 lg:block">
              @if (s.baseSha; as base) {
                vs {{ abbrev(base) }}
                @if (s.commit.parentShas.length > 1) {
                  (merge commit — first parent)
                }
              } @else {
                initial commit — everything is new
              }
            </span>
          }
        }
        <span class="flex-1"></span>
        @if (!comparingPath() && selectedRange(); as range) {
          <span class="shrink-0 text-[11px] text-indigo-300/80">
            {{ rangeLabel(range) }}
          </span>
          <button
            type="button"
            class="shrink-0 rounded border border-indigo-300/30 px-1.5 py-0.5 text-[11px] text-indigo-100 transition hover:bg-indigo-300/10"
            (click)="traceSelection()"
          >
            Trace selection
          </button>
          <button
            type="button"
            class="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="Clear line selection"
            title="Clear line selection"
            (click)="clearSelection()"
          >
            ×
          </button>
        }
        @if (blameComputing()) {
          <span class="shrink-0 text-[11px] text-indigo-300/80">annotating…</span>
        }
        <button
          type="button"
          class="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition"
          [class]="
            historyActive()
              ? 'bg-indigo-500/20 text-indigo-200'
              : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'
          "
          (click)="historyToggle.emit()"
          aria-label="Toggle history panel"
          title="Show the commits that changed this file (h)"
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
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v4h4" />
            <path d="M12 7v5l3.5 2" />
          </svg>
          History
        </button>
        <button
          type="button"
          class="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition"
          [class]="
            blameActive()
              ? 'bg-indigo-500/20 text-indigo-200'
              : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'
          "
          (click)="blameToggle.emit()"
          aria-label="Toggle blame annotations"
          title="Split view: the version before on the left, after on the right, both annotated (b)"
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
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
            <rect x="8" y="2" width="8" height="4" rx="1" />
            <path d="M9 12h6M9 16h4" />
          </svg>
          Blame
        </button>
        @if (s.status === 'ready' && s.commit.htmlUrl) {
          <a
            class="shrink-0 text-[11px] text-zinc-500 transition hover:text-zinc-200"
            [href]="s.commit.htmlUrl"
            target="_blank"
            rel="noopener noreferrer"
            >View commit ↗</a
          >
        }
      </header>

      @if (s.status === 'loading') {
        <div class="flex-1 space-y-2.5 overflow-hidden p-4" aria-label="Computing changes">
          @for (width of skeletonWidths; track $index) {
            <div class="h-3.5 animate-pulse rounded bg-zinc-800/80" [style.width.%]="width"></div>
          }
        </div>
      } @else if (s.status === 'error') {
        <div class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p class="text-sm text-rose-400">{{ s.message }}</p>
          <button
            type="button"
            class="rounded-lg border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
            (click)="retry.emit()"
          >
            Try again
          </button>
        </div>
      } @else if (s.status === 'unavailable') {
        <div class="flex flex-1 items-center justify-center px-6 text-center">
          <p class="text-sm text-zinc-500">{{ s.reason }}</p>
        </div>
      } @else if (rows().length === 0) {
        <div class="flex flex-1 items-center justify-center px-6 text-center">
          <p class="text-sm text-zinc-500">
            No line changes in this commit — likely a metadata-only change.
          </p>
        </div>
      } @else if (splitMode()) {
        <div class="flex h-6 shrink-0 border-b border-zinc-800 bg-zinc-900/40 text-[11px]">
          <span class="flex w-1/2 items-center gap-1 border-r border-zinc-800/80 px-4 text-zinc-500"
            >Before
            @if (s.basePath; as basePath) {
              @if (basePath !== path()) {
                <span class="truncate">{{ basePath }}</span>
              }
            } @else if (s.baseSha) {
              <span>(nothing at parent)</span>
            } @else {
              <span>(nothing — initial commit)</span>
            }
            @if (s.baseSha; as base) {
              <span class="font-mono">{{ abbrev(base) }}</span>
            }
          </span>
          <span class="flex w-1/2 items-center gap-1 px-4 text-zinc-500"
            >After
            @if (s.headPath; as headPath) {
              @if (headPath !== path()) {
                <span class="truncate">{{ headPath }}</span>
              }
            } @else {
              <span>(deleted)</span>
            }
            <span class="font-mono">{{ abbrev(s.commit.sha) }}</span>
          </span>
        </div>
        <div #scroller class="slim-scrollbar min-h-0 flex-1 overflow-auto">
          <div class="relative font-mono text-[13px] leading-6">
            @for (row of splitRows(); track $index) {
              @if (row.type === 'hunk') {
                <div class="flex items-center bg-sky-500/10 text-sky-300/80">
                  <span class="px-4 whitespace-pre">{{ row.header }}</span>
                  @if (canStepBefore()) {
                    <button
                      type="button"
                      class="ml-2 shrink-0 rounded border border-sky-300/30 px-1.5 text-[11px] leading-4 text-sky-200/90 transition hover:bg-sky-300/10"
                      title="Annotate the version before this change, at this hunk"
                      (click)="
                        before.emit({
                          oldStart: row.hunkOldStart || 1,
                          newStart: row.hunkNewStart || 1,
                        })
                      "
                    >
                      ◂ Before
                    </button>
                  }
                </div>
              } @else {
                <div
                  class="flex"
                  [class.trace-highlight-row]="
                    row.type === 'line' && row.right && lineHighlighted(row.right.lineNo)
                  "
                >
                  <div
                    class="flex w-1/2 min-w-0 border-r border-zinc-800/80"
                    [class.bg-rose-500/10]="row.left?.changed"
                    [class.bg-zinc-900/30]="!row.left"
                  >
                    @if (row.left; as cell) {
                      @let lc = leftCells()[cell.lineNo - 1];
                      <span class="w-40 shrink-0 pl-3 text-xs leading-6 select-none">
                        @if (lc.sha; as sha) {
                          <button
                            type="button"
                            class="blame-tooltip max-w-full cursor-pointer align-top underline-offset-2 transition hover:underline"
                            [class]="lc.labelClass"
                            [attr.data-blame-title]="lc.title"
                            [title]="lc.title"
                            (click)="blameSelect.emit({ sha, line: lc.lineAtCommit })"
                          >
                            <span class="block truncate">{{ lc.label }}</span>
                          </button>
                        } @else if (lc.pending) {
                          <span class="animate-pulse text-zinc-700">·</span>
                        } @else if (lc.label) {
                          <span
                            class="blame-tooltip inline-block max-w-full"
                            [class]="lc.labelClass"
                            [attr.data-blame-title]="lc.title"
                            [title]="lc.title"
                            ><span class="block truncate">{{ lc.label }}</span></span
                          >
                        }
                      </span>
                      <span
                        class="w-9 shrink-0 border-l border-zinc-800/60 pr-2 text-right text-zinc-600 select-none"
                        aria-hidden="true"
                        >{{ cell.lineNo }}</span
                      >
                      <span class="w-12 shrink-0 text-center select-none">
                        @if (!comparingPath() && row.traceRange; as range) {
                          @if (!row.right) {
                            <button
                              type="button"
                              class="rounded border border-sky-300/30 px-1.5 text-[11px] leading-4 text-sky-200/90 transition hover:bg-sky-300/10"
                              title="Trace this changed block"
                              (click)="trace.emit(range)"
                            >
                              Trace
                            </button>
                          }
                        }
                      </span>
                      <span
                        class="min-w-0 flex-1 overflow-hidden pr-4 pl-3 whitespace-pre [tab-size:4]"
                        [class]="row.left.changed ? 'text-rose-200' : 'text-zinc-300'"
                        >{{ cell.text }}</span
                      >
                    }
                  </div>
                  <div
                    class="flex w-1/2 min-w-0"
                    [class.bg-emerald-500/10]="row.right?.changed"
                    [class.bg-zinc-900/30]="!row.right"
                  >
                    @if (row.right; as cell) {
                      @let rc = rightCells()[cell.lineNo - 1];
                      <span class="w-40 shrink-0 pl-3 text-xs leading-6 select-none">
                        @if (rc.sha; as sha) {
                          <button
                            type="button"
                            class="blame-tooltip max-w-full cursor-pointer align-top underline-offset-2 transition hover:underline"
                            [class]="rc.labelClass"
                            [attr.data-blame-title]="rc.title"
                            [title]="rc.title"
                            (click)="blameSelect.emit({ sha, line: rc.lineAtCommit })"
                          >
                            <span class="block truncate">{{ rc.label }}</span>
                          </button>
                        } @else if (rc.pending) {
                          <span class="animate-pulse text-zinc-700">·</span>
                        } @else if (rc.label) {
                          <span
                            class="blame-tooltip inline-block max-w-full"
                            [class]="rc.labelClass"
                            [attr.data-blame-title]="rc.title"
                            [title]="rc.title"
                            ><span class="block truncate">{{ rc.label }}</span></span
                          >
                        }
                      </span>
                      <span
                        class="w-9 shrink-0 border-l border-zinc-800/60 pr-0 text-right text-zinc-600 select-none"
                      >
                        <button
                          type="button"
                          class="h-6 w-full pr-2 text-right transition hover:bg-indigo-500/10 hover:text-indigo-200"
                          [class.bg-indigo-500/20]="lineSelected(cell.lineNo)"
                          [class.text-indigo-100]="lineSelected(cell.lineNo)"
                          [attr.aria-label]="'Select line ' + cell.lineNo"
                          (click)="selectLine(cell.lineNo, $event)"
                        >
                          {{ cell.lineNo }}
                        </button>
                      </span>
                      <span class="w-12 shrink-0 text-center select-none">
                        @if (!comparingPath() && row.traceRange; as range) {
                          @if (row.right) {
                            <button
                              type="button"
                              class="rounded border border-sky-300/30 px-1.5 text-[11px] leading-4 text-sky-200/90 transition hover:bg-sky-300/10"
                              title="Trace this changed block"
                              (click)="trace.emit(range)"
                            >
                              Trace
                            </button>
                          }
                        }
                      </span>
                      <span
                        class="min-w-0 flex-1 overflow-hidden pr-4 pl-3 whitespace-pre [tab-size:4]"
                        [class]="row.right.changed ? 'text-emerald-200' : 'text-zinc-300'"
                        >{{ cell.text }}</span
                      >
                    }
                  </div>
                </div>
              }
            }
          </div>
        </div>
      } @else {
        <div #scroller class="slim-scrollbar min-h-0 flex-1 overflow-auto">
          <div class="relative min-w-max font-mono text-[13px] leading-6">
            @for (row of rows(); track $index) {
              @if (row.type === 'hunk') {
                <div class="flex items-center bg-sky-500/10 text-sky-300/80">
                  <span class="w-24 shrink-0 select-none"></span>
                  <span class="px-4 whitespace-pre">{{ row.text }}</span>
                  @if (canStepBefore()) {
                    <button
                      type="button"
                      class="ml-2 shrink-0 rounded border border-sky-300/30 px-1.5 text-[11px] leading-4 text-sky-200/90 transition hover:bg-sky-300/10"
                      title="Annotate the version before this change, at this hunk"
                      (click)="
                        before.emit({
                          oldStart: row.hunkOldStart || 1,
                          newStart: row.hunkNewStart || 1,
                        })
                      "
                    >
                      ◂ Before
                    </button>
                  }
                </div>
              } @else {
                <div
                  class="flex"
                  [class.bg-emerald-500/10]="row.type === 'add'"
                  [class.bg-rose-500/10]="row.type === 'remove'"
                  [class.trace-highlight-row]="
                    row.newLine !== undefined && lineHighlighted(row.newLine)
                  "
                >
                  <span
                    class="w-10 shrink-0 pr-1 text-right text-zinc-600 select-none"
                    aria-hidden="true"
                    >{{ row.oldNo }}</span
                  >
                  <span class="w-10 shrink-0 pr-0 text-right text-zinc-600 select-none">
                    @if (row.newLine; as line) {
                      <button
                        type="button"
                        class="h-6 w-full pr-1 text-right transition hover:bg-indigo-500/10 hover:text-indigo-200"
                        [class.bg-indigo-500/20]="lineSelected(line)"
                        [class.text-indigo-100]="lineSelected(line)"
                        [attr.aria-label]="'Select line ' + line"
                        (click)="selectLine(line, $event)"
                      >
                        {{ line }}
                      </button>
                    } @else {
                      <span class="pr-1">{{ row.newNo }}</span>
                    }
                  </span>
                  <span
                    class="w-4 shrink-0 text-center select-none"
                    [class.text-emerald-400]="row.type === 'add'"
                    [class.text-rose-400]="row.type === 'remove'"
                    aria-hidden="true"
                    >{{ row.marker }}</span
                  >
                  <span class="w-12 shrink-0 text-center select-none">
                    @if (!comparingPath() && row.traceRange; as range) {
                      <button
                        type="button"
                        class="rounded border border-sky-300/30 px-1.5 text-[11px] leading-4 text-sky-200/90 transition hover:bg-sky-300/10"
                        title="Trace this changed block"
                        (click)="trace.emit(range)"
                      >
                        Trace
                      </button>
                    }
                  </span>
                  <span
                    class="pr-10 whitespace-pre [tab-size:4]"
                    [class.text-emerald-200]="row.type === 'add'"
                    [class.text-rose-200]="row.type === 'remove'"
                    [class.text-zinc-400]="row.type === 'ctx'"
                    >{{ row.text }}</span
                  >
                </div>
              }
            }
          </div>
        </div>
      }
    }
  `,
})
export class DiffView {
  readonly state = input.required<DiffState | null>();
  readonly path = input.required<string | null>();
  /** 1-based new-side line to highlight and scroll to, if any. */
  readonly highlightLine = input<number | null>(null);
  /** 1-based inclusive new-side range to highlight and scroll to, if any. */
  readonly highlightRange = input<LineRange | null>(null);
  /** Renders the side-by-side annotated view instead of the unified diff. */
  readonly splitMode = input(false);
  /** Blame of the parent version (left side). */
  readonly leftBlame = input<BlameState | null>(null);
  /** Blame of the commit's version (right side). */
  readonly rightBlame = input<BlameState | null>(null);
  /** Highlights the Blame toggle. */
  readonly blameActive = input(false);
  /** Highlights the History toggle while the panel is open. */
  readonly historyActive = input(false);
  /** False when the file has no earlier version (created by this commit). */
  readonly beforeAvailable = input(true);

  readonly retry = output<void>();
  readonly historyToggle = output<void>();
  /** "Before this change": the hunk's first old- and new-side lines. */
  readonly before = output<{ oldStart: number; newStart: number }>();
  /** "Trace": filter the history to this new-side line range. */
  readonly trace = output<LineRange>();
  readonly blameToggle = output<void>();
  /** A clicked annotation: the commit plus the line's position at it. */
  readonly blameSelect = output<{ sha: string; line: number }>();
  /** Clears a predecessor comparison, back to the commit's own changes. */
  readonly comparisonClear = output<void>();

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private lastScrollKey: string | null = null;

  protected readonly skeletonWidths = [70, 45, 88, 60, 35, 78, 52];

  private readonly diffKey = computed(() => {
    const s = this.state();
    if (s?.status !== 'ready') return null;
    return `${this.path() ?? ''}:${s.commit.sha}:${s.basePath ?? ''}:${s.headPath ?? ''}`;
  });

  private readonly selection = signal<{
    readonly key: string;
    readonly anchor: number;
    readonly range: LineRange;
  } | null>(null);

  protected readonly selectedRange = computed<LineRange | null>(() => {
    const key = this.diffKey();
    const selection = this.selection();
    return key && selection?.key === key ? selection.range : null;
  });

  protected readonly canStepBefore = computed(() => {
    const s = this.state();
    // "◂ Before" and the per-hunk/selection "Trace" all step through the
    // *selected file's* own timeline. A comparison against another file (the
    // rename/origin "Diff") has an unrelated before side, so those actions
    // would target the wrong file at the wrong lines — hide them there.
    return (
      s?.status === 'ready' && s.baseSha !== null && this.beforeAvailable() && !this.comparingPath()
    );
  });

  /** Predecessor path when the diff compares against one, else null. */
  protected readonly comparingPath = computed<string | null>(() => {
    const s = this.state();
    if (s?.status !== 'ready') return null;
    return s.basePath && s.basePath !== this.path() ? s.basePath : null;
  });

  protected readonly blameComputing = computed(
    () =>
      this.splitMode() &&
      (this.leftBlame()?.status === 'computing' || this.rightBlame()?.status === 'computing'),
  );

  protected readonly rows = computed<DiffRow[]>(() => {
    const s = this.state();
    if (!s || s.status !== 'ready') return [];
    const rows: DiffRow[] = [];
    for (const hunk of s.diff.hunks) {
      rows.push({
        type: 'hunk',
        oldNo: '',
        newNo: '',
        marker: '',
        text: hunk.header,
        hunkOldStart: hunk.oldStart,
        hunkNewStart: hunk.newStart,
      });
      const traceRanges = hunkChangeRanges(hunk);
      let traceIndex = 0;
      let inChangeRun = false;
      for (const op of hunk.ops) {
        if (op.kind === 'equal') {
          inChangeRun = false;
          rows.push({
            type: 'ctx',
            oldNo: String(op.oldLine),
            newNo: String(op.newLine),
            newLine: op.newLine,
            marker: '',
            text: op.text,
          });
        } else if (op.kind === 'remove') {
          const traceRange = !inChangeRun ? traceRanges[traceIndex++] : undefined;
          inChangeRun = true;
          rows.push({
            type: 'remove',
            oldNo: String(op.oldLine),
            newNo: '',
            marker: '−',
            text: op.text,
            ...(traceRange ? { traceRange } : {}),
          });
        } else {
          const traceRange = !inChangeRun ? traceRanges[traceIndex++] : undefined;
          inChangeRun = true;
          rows.push({
            type: 'add',
            oldNo: '',
            newNo: String(op.newLine),
            newLine: op.newLine,
            marker: '+',
            text: op.text,
            ...(traceRange ? { traceRange } : {}),
          });
        }
      }
    }
    return rows;
  });

  /** Side-by-side rows: removes paired with adds within each change run. */
  protected readonly splitRows = computed<SplitRow[]>(() => {
    const s = this.state();
    if (!s || s.status !== 'ready') return [];
    const rows: SplitRow[] = [];
    for (const hunk of s.diff.hunks) {
      rows.push({
        type: 'hunk',
        header: hunk.header,
        hunkOldStart: hunk.oldStart,
        hunkNewStart: hunk.newStart,
        left: null,
        right: null,
      });
      const traceRanges = hunkChangeRanges(hunk);
      let traceIndex = 0;
      let removes: SplitCell[] = [];
      let adds: SplitCell[] = [];
      let pendingTraceRange: LineRange | undefined;
      const flush = (): void => {
        const count = Math.max(removes.length, adds.length);
        for (let i = 0; i < count; i++) {
          rows.push({
            type: 'line',
            left: removes[i] ?? null,
            right: adds[i] ?? null,
            ...(i === 0 && pendingTraceRange ? { traceRange: pendingTraceRange } : {}),
          });
        }
        removes = [];
        adds = [];
        pendingTraceRange = undefined;
      };
      for (const op of hunk.ops) {
        if (op.kind === 'equal') {
          flush();
          rows.push({
            type: 'line',
            left: { lineNo: op.oldLine, text: op.text, changed: false },
            right: { lineNo: op.newLine, text: op.text, changed: false },
          });
        } else if (op.kind === 'remove') {
          pendingTraceRange ??= traceRanges[traceIndex++];
          removes.push({ lineNo: op.oldLine, text: op.text, changed: true });
        } else {
          pendingTraceRange ??= traceRanges[traceIndex++];
          adds.push({ lineNo: op.newLine, text: op.text, changed: true });
        }
      }
      flush();
    }
    return rows;
  });

  protected readonly leftCells = computed<readonly AnnotationCell[]>(() => {
    const s = this.state();
    if (s?.status !== 'ready') return [];
    return buildAnnotationCells(this.leftBlame(), s.diff.oldLineCount);
  });

  protected readonly rightCells = computed<readonly AnnotationCell[]>(() => {
    const s = this.state();
    if (s?.status !== 'ready') return [];
    return buildAnnotationCells(this.rightBlame(), s.diff.newLineCount);
  });

  protected lineSelected(line: number): boolean {
    const range = this.selectedRange();
    return !!range && line >= range.start && line <= range.end;
  }

  protected lineHighlighted(line: number): boolean {
    const range = this.effectiveHighlightRange();
    return !!range && line >= range.start && line <= range.end;
  }

  protected selectLine(line: number, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    // Selecting lines only feeds "Trace selection", which is disabled while
    // comparing against another file — so don't strand a highlight here.
    if (this.comparingPath()) return;
    const key = this.diffKey();
    if (!key) return;
    const current = this.selection();
    const sameDiff = current?.key === key;
    const extendFromSingleLine =
      sameDiff && current.range.start === current.range.end && current.anchor !== line;
    const anchor = (sameDiff && event.shiftKey) || extendFromSingleLine ? current.anchor : line;
    this.selection.set({
      key,
      anchor,
      range: { start: Math.min(anchor, line), end: Math.max(anchor, line) },
    });
  }

  protected clearSelection(): void {
    this.selection.set(null);
  }

  protected traceSelection(): void {
    const range = this.selectedRange();
    if (!range) return;
    this.trace.emit(range);
    this.clearSelection();
  }

  protected rangeLabel(range: LineRange): string {
    return range.start === range.end ? `line ${range.start}` : `lines ${range.start}–${range.end}`;
  }

  private readonly effectiveHighlightRange = computed<LineRange | null>(() => {
    const range = this.highlightRange();
    if (range) return range;
    const line = this.highlightLine();
    return line ? { start: line, end: line } : null;
  });

  /** Index of the row carrying the highlighted new-side line, if visible. */
  protected readonly highlightRowIndex = computed<number | null>(() => {
    const range = this.effectiveHighlightRange();
    if (!range) return null;
    if (this.splitMode()) {
      const index = this.splitRows().findIndex(
        (row) =>
          row.type === 'line' &&
          !!row.right &&
          row.right.lineNo >= range.start &&
          row.right.lineNo <= range.end,
      );
      return index === -1 ? null : index;
    }
    const index = this.rows().findIndex(
      (row) => row.newLine !== undefined && row.newLine >= range.start && row.newLine <= range.end,
    );
    return index === -1 ? null : index;
  });

  constructor() {
    afterRenderEffect(() => {
      const index = this.highlightRowIndex();
      const el = this.scroller()?.nativeElement;
      const key = this.diffKey();
      if (!el || !key) return;
      if (index !== null) {
        el.scrollTop = Math.max(0, index * LINE_HEIGHT_PX - el.clientHeight / 3);
        this.lastScrollKey = key;
      } else if (this.lastScrollKey !== key) {
        el.scrollTop = 0;
        this.lastScrollKey = key;
      }
    });
  }

  protected abbrev(sha: string): string {
    return shortSha(sha);
  }
}
