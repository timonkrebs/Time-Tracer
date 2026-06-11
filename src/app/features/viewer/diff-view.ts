import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  input,
  output,
  viewChild,
} from '@angular/core';

import { BlameState, DiffState } from '../../core/store/repo-store';
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
  /** First old-side line of the hunk; only set for hunk header rows. */
  readonly hunkOldStart?: number;
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
        <span class="flex-1"></span>
        @if (blameComputing()) {
          <span class="shrink-0 text-[11px] text-indigo-300/80">annotating…</span>
        }
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
          title="Split view: the version before on the left, after on the right, both annotated"
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
        @if (s.status === 'ready') {
          <a
            class="shrink-0 text-[11px] text-zinc-500 transition hover:text-zinc-200"
            [href]="s.commit.htmlUrl"
            target="_blank"
            rel="noopener noreferrer"
            >Commit on GitHub ↗</a
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
            @if (s.baseSha; as base) {
              <span class="font-mono">{{ abbrev(base) }}</span>
            } @else {
              <span>(nothing — initial commit)</span>
            }
          </span>
          <span class="flex w-1/2 items-center gap-1 px-4 text-zinc-500"
            >After <span class="font-mono">{{ abbrev(s.commit.sha) }}</span>
          </span>
        </div>
        <div #scroller class="slim-scrollbar min-h-0 flex-1 overflow-auto">
          <div class="relative font-mono text-[13px] leading-6">
            @if (highlightRowIndex(); as hl) {
              <div
                class="pointer-events-none absolute inset-x-0 z-10 h-6 bg-indigo-500/10 ring-1 ring-indigo-400/40 ring-inset"
                [style.top.px]="hl * 24"
              ></div>
            }
            @for (row of splitRows(); track $index) {
              @if (row.type === 'hunk') {
                <div class="flex items-center bg-sky-500/10 text-sky-300/80">
                  <span class="px-4 whitespace-pre">{{ row.header }}</span>
                  @if (canStepBefore()) {
                    <button
                      type="button"
                      class="mr-4 ml-2 shrink-0 rounded border border-sky-300/30 px-1.5 text-[11px] leading-4 text-sky-200/90 transition hover:bg-sky-300/10"
                      title="Annotate the version before this change, at this hunk"
                      (click)="before.emit(row.hunkOldStart || 1)"
                    >
                      ◂ Before
                    </button>
                  }
                </div>
              } @else {
                <div class="flex">
                  <div
                    class="flex w-1/2 min-w-0 border-r border-zinc-800/80"
                    [class.bg-rose-500/10]="row.left?.changed"
                    [class.bg-zinc-900/30]="!row.left"
                  >
                    @if (row.left; as cell) {
                      @let lc = leftCells()[cell.lineNo - 1];
                      <span class="w-40 shrink-0 truncate pl-3 text-xs leading-6 select-none">
                        @if (lc.sha; as sha) {
                          @if (lc.showLabel) {
                            <button
                              type="button"
                              class="max-w-full cursor-pointer truncate align-top underline-offset-2 transition hover:underline"
                              [class]="lc.colorClass"
                              [title]="lc.title"
                              (click)="blameSelect.emit({ sha, line: lc.lineAtCommit })"
                            >
                              {{ lc.label }}
                            </button>
                          }
                        } @else if (lc.pending) {
                          <span class="animate-pulse text-zinc-700">·</span>
                        } @else if (lc.showLabel) {
                          <span class="text-zinc-700" [title]="lc.title">{{ lc.label }}</span>
                        }
                      </span>
                      <span
                        class="w-9 shrink-0 border-l border-zinc-800/60 pr-2 text-right text-zinc-600 select-none"
                        aria-hidden="true"
                        >{{ cell.lineNo }}</span
                      >
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
                      <span class="w-40 shrink-0 truncate pl-3 text-xs leading-6 select-none">
                        @if (rc.sha; as sha) {
                          @if (rc.showLabel) {
                            <button
                              type="button"
                              class="max-w-full cursor-pointer truncate align-top underline-offset-2 transition hover:underline"
                              [class]="rc.colorClass"
                              [title]="rc.title"
                              (click)="blameSelect.emit({ sha, line: rc.lineAtCommit })"
                            >
                              {{ rc.label }}
                            </button>
                          }
                        } @else if (rc.pending) {
                          <span class="animate-pulse text-zinc-700">·</span>
                        } @else if (rc.showLabel) {
                          <span class="text-zinc-700" [title]="rc.title">{{ rc.label }}</span>
                        }
                      </span>
                      <span
                        class="w-9 shrink-0 border-l border-zinc-800/60 pr-2 text-right text-zinc-600 select-none"
                        aria-hidden="true"
                        >{{ cell.lineNo }}</span
                      >
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
            @if (highlightRowIndex(); as hl) {
              <div
                class="pointer-events-none absolute inset-x-0 h-6 bg-indigo-500/10 ring-1 ring-indigo-400/40 ring-inset"
                [style.top.px]="hl * 24"
              ></div>
            }
            @for (row of rows(); track $index) {
              @if (row.type === 'hunk') {
                <div class="flex items-center bg-sky-500/10 text-sky-300/80">
                  <span class="w-24 shrink-0 select-none"></span>
                  <span class="px-4 whitespace-pre">{{ row.text }}</span>
                  @if (canStepBefore()) {
                    <button
                      type="button"
                      class="mr-4 ml-2 shrink-0 rounded border border-sky-300/30 px-1.5 text-[11px] leading-4 text-sky-200/90 transition hover:bg-sky-300/10"
                      title="Annotate the version before this change, at this hunk"
                      (click)="before.emit(row.hunkOldStart || 1)"
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
                >
                  <span
                    class="w-10 shrink-0 pr-1 text-right text-zinc-600 select-none"
                    aria-hidden="true"
                    >{{ row.oldNo }}</span
                  >
                  <span
                    class="w-10 shrink-0 pr-1 text-right text-zinc-600 select-none"
                    aria-hidden="true"
                    >{{ row.newNo }}</span
                  >
                  <span
                    class="w-4 shrink-0 text-center select-none"
                    [class.text-emerald-400]="row.type === 'add'"
                    [class.text-rose-400]="row.type === 'remove'"
                    aria-hidden="true"
                    >{{ row.marker }}</span
                  >
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
  /** Renders the side-by-side annotated view instead of the unified diff. */
  readonly splitMode = input(false);
  /** Blame of the parent version (left side). */
  readonly leftBlame = input<BlameState | null>(null);
  /** Blame of the commit's version (right side). */
  readonly rightBlame = input<BlameState | null>(null);
  /** Highlights the Blame toggle. */
  readonly blameActive = input(false);

  readonly retry = output<void>();
  /** "Before this change": emits the hunk's first old-side line. */
  readonly before = output<number>();
  readonly blameToggle = output<void>();
  /** A clicked annotation: the commit plus the line's position at it. */
  readonly blameSelect = output<{ sha: string; line: number }>();

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  protected readonly skeletonWidths = [70, 45, 88, 60, 35, 78, 52];

  protected readonly canStepBefore = computed(() => {
    const s = this.state();
    return s?.status === 'ready' && s.baseSha !== null;
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
      });
      for (const op of hunk.ops) {
        if (op.kind === 'equal') {
          rows.push({
            type: 'ctx',
            oldNo: String(op.oldLine),
            newNo: String(op.newLine),
            marker: '',
            text: op.text,
          });
        } else if (op.kind === 'remove') {
          rows.push({
            type: 'remove',
            oldNo: String(op.oldLine),
            newNo: '',
            marker: '−',
            text: op.text,
          });
        } else {
          rows.push({
            type: 'add',
            oldNo: '',
            newNo: String(op.newLine),
            marker: '+',
            text: op.text,
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
        left: null,
        right: null,
      });
      let removes: SplitCell[] = [];
      let adds: SplitCell[] = [];
      const flush = (): void => {
        const count = Math.max(removes.length, adds.length);
        for (let i = 0; i < count; i++) {
          rows.push({ type: 'line', left: removes[i] ?? null, right: adds[i] ?? null });
        }
        removes = [];
        adds = [];
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
          removes.push({ lineNo: op.oldLine, text: op.text, changed: true });
        } else {
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

  /** Index of the row carrying the highlighted new-side line, if visible. */
  protected readonly highlightRowIndex = computed<number | null>(() => {
    const line = this.highlightLine();
    if (!line) return null;
    if (this.splitMode()) {
      const index = this.splitRows().findIndex(
        (row) => row.type === 'line' && row.right?.lineNo === line,
      );
      return index === -1 ? null : index;
    }
    const target = String(line);
    const index = this.rows().findIndex((row) => row.type !== 'remove' && row.newNo === target);
    return index === -1 ? null : index;
  });

  constructor() {
    afterRenderEffect(() => {
      const index = this.highlightRowIndex();
      const el = this.scroller()?.nativeElement;
      if (index === null || !el) return;
      el.scrollTop = Math.max(0, index * LINE_HEIGHT_PX - el.clientHeight / 3);
    });
  }

  protected abbrev(sha: string): string {
    return shortSha(sha);
  }
}
