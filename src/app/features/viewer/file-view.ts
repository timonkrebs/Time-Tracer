import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { RepoWebLinks } from '../../core/git/git-provider';
import { FileState } from '../../core/models';
import { BlameState } from '../../core/store/repo-store';
import { LineRange } from '../../core/util/line-range';
import { AnnotationCell, buildAnnotationCells } from './blame-annotation';

/** Line height of code rows (`leading-6`), used for scroll/highlight maths. */
const LINE_HEIGHT_PX = 24;

/**
 * Blamed files above this many lines are row-virtualized: only the rows in (or
 * near) the viewport are in the DOM, kept in place by spacers above and below.
 * Smaller files render every row as before, so their horizontal scroll width
 * is exact.
 */
const VIRTUALIZE_THRESHOLD = 800;

/** Extra rows rendered beyond the viewport, so fast scrolls stay filled. */
const ROW_OVERSCAN = 12;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface BlameRow {
  readonly lineNo: number;
  readonly text: string;
  readonly cell: AnnotationCell;
}

/** The rows to render plus the spacer heights that hold the rest of the scroll. */
interface BlameWindow {
  readonly rows: readonly BlameRow[];
  readonly topPad: number;
  readonly bottomPad: number;
}

/**
 * Right pane of the viewer: renders the selected file (text with a line
 * number gutter), or the matching empty/loading/binary/too-large/error
 * state. With blame enabled, the gutter carries per-line commit
 * annotations — clicking one jumps to the commit that introduced the line.
 */
@Component({
  selector: 'app-file-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    @if (state(); as s) {
      <header
        class="flex h-10 shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-900/60 px-4"
      >
        <span class="truncate font-mono text-xs text-zinc-300">{{ s.path }}</span>
        @if (textInfo(); as info) {
          <span class="shrink-0 text-[11px] text-zinc-600">
            {{ info.lineCount }} lines · {{ info.formattedSize }}
          </span>
        }
        <span class="flex-1"></span>
        @if (selectedRange(); as range) {
          <span class="shrink-0 text-[11px] text-indigo-300/80">{{ rangeLabel(range) }}</span>
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
            blameActive()
              ? 'bg-indigo-500/20 text-indigo-200'
              : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'
          "
          (click)="blameToggle.emit()"
          aria-label="Toggle blame annotations"
          title="Annotate each line with the commit that introduced it"
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
          title="Show the commits that changed this file"
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
        @if (links()?.rawFileUrl; as rawUrl) {
          <a
            class="shrink-0 text-[11px] text-zinc-500 transition hover:text-zinc-200"
            [href]="rawUrl"
            target="_blank"
            rel="noopener noreferrer"
            >Raw</a
          >
        }
        @if (links()?.fileUrl; as fileUrl) {
          <a
            class="shrink-0 text-[11px] text-zinc-500 transition hover:text-zinc-200"
            [href]="fileUrl"
            target="_blank"
            rel="noopener noreferrer"
            >GitHub ↗</a
          >
        }
      </header>

      @if (s.status === 'loading') {
        <div class="flex-1 space-y-2.5 overflow-hidden p-4" aria-label="Loading file">
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
            (click)="retry.emit(s.path)"
          >
            Try again
          </button>
        </div>
      } @else {
        @if (blameNotice(); as notice) {
          <div
            class="shrink-0 border-b border-amber-400/20 bg-amber-400/5 px-4 py-1 text-[11px] text-amber-300/90"
          >
            {{ notice }}
          </div>
        }
        @if (blameWindow(); as win) {
          <div #scroller (scroll)="onBlameScroll($event)" class="slim-scrollbar min-h-0 flex-1 overflow-auto">
            <div class="relative min-w-max font-mono text-[13px] leading-6">
              @if (effectiveHighlightRange(); as range) {
                <div
                  class="pointer-events-none absolute inset-x-0 h-6 bg-indigo-500/10 ring-1 ring-indigo-400/40 ring-inset"
                  [style.top.px]="(range.start - 1) * 24"
                  [style.height.px]="(range.end - range.start + 1) * 24"
                ></div>
              }
              @if (win.topPad) {
                <div aria-hidden="true" [style.height.px]="win.topPad"></div>
              }
              @for (row of win.rows; track row.lineNo) {
                <div class="flex hover:bg-white/[0.02]">
                  <span class="w-52 shrink-0 pl-4 text-xs leading-6 select-none">
                    @if (row.cell.sha; as sha) {
                      <button
                        type="button"
                        class="blame-tooltip max-w-full cursor-pointer align-top underline-offset-2 transition hover:underline"
                        [class]="row.cell.labelClass"
                        [attr.data-blame-title]="row.cell.title"
                        [title]="row.cell.title"
                        (click)="blameSelect.emit({ sha, line: row.cell.lineAtCommit })"
                      >
                        <span class="block truncate">{{ row.cell.label }}</span>
                      </button>
                    } @else if (row.cell.pending) {
                      <span class="animate-pulse text-zinc-700">·</span>
                    } @else if (row.cell.label) {
                      <span
                        class="blame-tooltip inline-block max-w-full"
                        [class]="row.cell.labelClass"
                        [attr.data-blame-title]="row.cell.title"
                        [title]="row.cell.title"
                        ><span class="block truncate">{{ row.cell.label }}</span></span
                      >
                    }
                  </span>
                  <span
                    class="w-10 shrink-0 border-l border-zinc-800/60 pr-0 text-right text-zinc-600 select-none"
                  >
                    <button
                      type="button"
                      class="h-6 w-full pr-2 text-right transition hover:bg-indigo-500/10 hover:text-indigo-200"
                      [class.bg-indigo-500/20]="lineSelected(row.lineNo)"
                      [class.text-indigo-100]="lineSelected(row.lineNo)"
                      [attr.aria-label]="'Select line ' + row.lineNo"
                      (click)="selectLine(row.lineNo, $event)"
                    >
                      {{ row.lineNo }}
                    </button>
                  </span>
                  <span class="pr-10 pl-3 whitespace-pre text-zinc-200 [tab-size:4]">{{
                    row.text
                  }}</span>
                </div>
              }
              @if (win.bottomPad) {
                <div aria-hidden="true" [style.height.px]="win.bottomPad"></div>
              }
            </div>
          </div>
        } @else if (textInfo(); as info) {
          <div #scroller class="slim-scrollbar min-h-0 flex-1 overflow-auto">
            <div class="relative flex min-w-max font-mono text-[13px] leading-6">
              @if (effectiveHighlightRange(); as range) {
                <div
                  class="pointer-events-none absolute inset-x-0 h-6 bg-indigo-500/10 ring-1 ring-indigo-400/40 ring-inset"
                  [style.top.px]="12 + (range.start - 1) * 24"
                  [style.height.px]="(range.end - range.start + 1) * 24"
                ></div>
              }
              <pre
                class="sticky left-0 shrink-0 border-r border-zinc-800/80 bg-zinc-950 py-3 pr-3 pl-4 text-right text-zinc-600 select-none"
                aria-hidden="true"
                >{{ info.numbers }}</pre
              >
              <pre class="py-3 pr-10 pl-4 text-zinc-200 [tab-size:4]">{{ info.text }}</pre>
            </div>
          </div>
        } @else if (s.file.kind === 'binary') {
          <div class="flex flex-1 flex-col items-center justify-center gap-2 text-zinc-500">
            <p class="text-sm">Binary file — no text preview</p>
            <p class="text-xs">{{ formattedSize(s.file.size) }}</p>
          </div>
        } @else if (s.file.kind === 'too-large') {
          <div class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <p class="text-sm text-zinc-400">
              This file is {{ formattedSize(s.file.size) }} — too large to preview here.
            </p>
            @if (links()?.fileUrl; as fileUrl) {
              <a
                class="text-xs text-indigo-300 hover:underline"
                [href]="fileUrl"
                target="_blank"
                rel="noopener noreferrer"
                >Open it on GitHub instead</a
              >
            }
          </div>
        }
      }
    } @else {
      <div class="flex flex-1 flex-col items-center justify-center gap-3 text-zinc-600">
        <svg
          class="size-10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
        <p class="text-sm">Select a file from the tree to view it</p>
      </div>
    }
  `,
})
export class FileView {
  readonly state = input.required<FileState | null>();
  readonly links = input<RepoWebLinks | null>(null);
  /** Highlights the History button while the panel is open. */
  readonly historyActive = input(false);
  /** Renders per-line blame annotations in the gutter. */
  readonly blameActive = input(false);
  readonly blame = input<BlameState | null>(null);
  /** Commit/ref key of the rendered file, used to reset scroll between navigations. */
  readonly viewKey = input<string | null>(null);
  /** 1-based line to highlight and scroll into view, if any. */
  readonly highlightLine = input<number | null>(null);
  /** 1-based inclusive range to highlight and scroll into view, if any. */
  readonly highlightRange = input<LineRange | null>(null);

  /** Emits the path when the user wants to retry a failed fetch. */
  readonly retry = output<string>();
  readonly historyToggle = output<void>();
  readonly blameToggle = output<void>();
  /** A clicked annotation: the commit plus the line's position at it. */
  readonly blameSelect = output<{ sha: string; line: number }>();
  /** "Trace selection": follow a chosen gutter line range back through history. */
  readonly trace = output<LineRange>();

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private lastScrollKey: string | null = null;

  /** Scroll position and viewport height of the blame scroller, for windowing. */
  private readonly scrollTop = signal(0);
  private readonly viewportHeight = signal(0);

  /** Gutter line selection, valid only for the file/version it was made in. */
  private readonly selection = signal<{
    readonly key: string;
    readonly anchor: number;
    readonly range: LineRange;
  } | null>(null);

  protected readonly skeletonWidths = [62, 84, 45, 91, 73, 38, 80, 55, 67, 49, 88, 30];

  constructor() {
    afterRenderEffect(() => {
      const line = this.effectiveHighlightRange()?.start ?? this.highlightLine();
      this.textInfo(); // re-scroll when a different file/version renders
      const key = this.scrollKey();
      const el = this.scroller()?.nativeElement;
      if (!el || !key) return;
      if (line) {
        el.scrollTop = Math.max(0, (line - 1) * LINE_HEIGHT_PX - el.clientHeight / 3);
        this.lastScrollKey = key;
      } else if (this.lastScrollKey !== key) {
        el.scrollTop = 0;
        this.lastScrollKey = key;
      }
    });

    // Track the scroller's viewport height (it drives the virtual window) and
    // keep it current as the split pane is resized.
    effect((onCleanup) => {
      const el = this.scroller()?.nativeElement;
      if (!el) return;
      this.viewportHeight.set(el.clientHeight);
      this.scrollTop.set(el.scrollTop);
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => this.viewportHeight.set(el.clientHeight));
      observer.observe(el);
      onCleanup(() => observer.disconnect());
    });
  }

  protected onBlameScroll(event: Event): void {
    const el = event.target as HTMLElement;
    this.scrollTop.set(el.scrollTop);
    this.viewportHeight.set(el.clientHeight);
  }

  private readonly scrollKey = computed(() => {
    const s = this.state();
    if (!s || s.status !== 'ready') return null;
    return `${s.path}:${this.viewKey() ?? 'tip'}:${s.file.sha}`;
  });

  protected readonly effectiveHighlightRange = computed<LineRange | null>(() => {
    const range = this.highlightRange();
    if (range) return range;
    const line = this.highlightLine();
    return line ? { start: line, end: line } : null;
  });

  /** The active gutter selection, dropped once a different file/version renders. */
  protected readonly selectedRange = computed<LineRange | null>(() => {
    const key = this.scrollKey();
    const selection = this.selection();
    return key && selection?.key === key ? selection.range : null;
  });

  protected lineSelected(line: number): boolean {
    const range = this.selectedRange();
    return !!range && line >= range.start && line <= range.end;
  }

  /**
   * Selects a gutter line; shift-clicking (or a follow-up click after a single
   * line) extends the range from the anchor — mirrors the changes view.
   */
  protected selectLine(line: number, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const key = this.scrollKey();
    if (!key) return;
    const current = this.selection();
    const sameFile = current?.key === key;
    const extendFromSingleLine =
      sameFile && current.range.start === current.range.end && current.anchor !== line;
    const anchor = (sameFile && event.shiftKey) || extendFromSingleLine ? current.anchor : line;
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

  protected readonly textInfo = computed(() => {
    const s = this.state();
    if (!s || s.status !== 'ready' || s.file.kind !== 'text') return null;
    // Drop a single trailing newline so the gutter doesn't count a phantom line.
    const text = s.file.text.endsWith('\n') ? s.file.text.slice(0, -1) : s.file.text;
    const lineCount = text === '' ? 1 : text.split('\n').length;
    let numbers = '';
    for (let i = 1; i <= lineCount; i++) numbers += i === 1 ? '1' : `\n${i}`;
    return { text, lineCount, numbers, formattedSize: formatBytes(s.file.size) };
  });

  protected readonly blameComputing = computed(
    () => this.blameActive() && this.blame()?.status === 'computing',
  );

  protected readonly blameNotice = computed(() => {
    if (!this.blameActive()) return null;
    const blame = this.blame();
    if (!blame) return null;
    if (blame.status === 'unavailable' || blame.status === 'error') return blame.message ?? null;
    if (blame.status === 'ready' && blame.truncated) {
      return 'Some lines predate the loaded history — load older commits in the History panel to attribute them.';
    }
    return null;
  });

  /** Per-line rows with annotations; null when blame rendering is off. */
  protected readonly blameRows = computed<BlameRow[] | null>(() => {
    if (!this.blameActive()) return null;
    const info = this.textInfo();
    if (!info) return null;
    const lines = info.text.split('\n');
    const cells = buildAnnotationCells(this.blame(), lines.length);
    return lines.map((text, index) => ({ lineNo: index + 1, text, cell: cells[index] }));
  });

  /**
   * The slice of blame rows to actually render. Small files render whole (zero
   * spacers, exact horizontal width); large files render only the rows in the
   * viewport, held in place by a top and bottom spacer summing to the rest.
   */
  protected readonly blameWindow = computed<BlameWindow | null>(() => {
    const rows = this.blameRows();
    if (!rows) return null;
    const total = rows.length;
    if (total <= VIRTUALIZE_THRESHOLD) return { rows, topPad: 0, bottomPad: 0 };

    // Before the scroller is measured, fall back to a viewport tall enough to
    // fill any screen so the first paint is never blank.
    const height = this.viewportHeight() || 1200;
    const top = this.scrollTop();
    const first = Math.max(0, Math.floor(top / LINE_HEIGHT_PX) - ROW_OVERSCAN);
    const last = Math.min(total, Math.ceil((top + height) / LINE_HEIGHT_PX) + ROW_OVERSCAN);
    return {
      rows: rows.slice(first, last),
      topPad: first * LINE_HEIGHT_PX,
      bottomPad: (total - last) * LINE_HEIGHT_PX,
    };
  });

  protected formattedSize(bytes: number): string {
    return formatBytes(bytes);
  }
}
