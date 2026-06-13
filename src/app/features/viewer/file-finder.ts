import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { TreeEntry } from '../../core/models';
import { Segment, fuzzyMatchPath, highlightSegments } from '../../core/util/fuzzy';

/** Number of ranked results rendered at once. */
const MAX_RESULTS = 50;

interface FinderResult {
  readonly path: string;
  readonly name: Segment[];
  /** Directory prefix (without the file name); empty for root files. */
  readonly dir: Segment[];
}

/**
 * Quick open / fuzzy file finder — a command-palette overlay over the
 * repository's files. Type to filter by path (boundary- and run-aware
 * ranking), arrow keys to move, Enter to open, Escape to dismiss. Reads the
 * full tree the store already holds, so it costs no extra requests.
 */
@Component({
  selector: 'app-file-finder',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-sm"
      (pointerdown)="onBackdrop($event)"
    >
      <div
        class="flex max-h-[68vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Find a file"
      >
        <div class="flex items-center gap-2 border-b border-zinc-800 px-3">
          <svg
            class="size-4 shrink-0 text-zinc-500"
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
          <input
            #search
            type="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="Go to file…"
            aria-label="File name"
            class="h-11 min-w-0 flex-1 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-600 outline-none"
            [value]="query()"
            (input)="onInput($event)"
            (keydown)="onKeydown($event)"
          />
          <kbd
            class="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-500"
          >
            esc
          </kbd>
        </div>

        @if (results().length === 0) {
          <p class="px-4 py-6 text-center text-sm text-zinc-500">
            {{ query().trim() ? 'No files match.' : 'This repository has no files.' }}
          </p>
        } @else {
          <ul #list class="slim-scrollbar min-h-0 flex-1 overflow-y-auto py-1">
            @for (result of results(); track result.path; let i = $index) {
              <li>
                <button
                  type="button"
                  class="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm transition-colors"
                  [class]="i === activeIndex() ? 'bg-indigo-500/20' : 'hover:bg-white/5'"
                  (pointermove)="activeIndex.set(i)"
                  (click)="choose(result.path)"
                >
                  <svg
                    class="size-4 shrink-0 translate-y-0.5 text-zinc-500"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6" />
                  </svg>
                  <span class="min-w-0 truncate text-zinc-200">
                    @for (part of result.name; track $index) {
                      <span
                        [class.font-semibold]="part.match"
                        [class.text-indigo-300]="part.match"
                        >{{ part.text }}</span
                      >
                    }
                  </span>
                  @if (result.dir.length) {
                    <span class="min-w-0 flex-1 truncate text-right text-xs text-zinc-600">
                      @for (part of result.dir; track $index) {
                        <span [class.text-indigo-300]="part.match">{{ part.text }}</span>
                      }
                    </span>
                  }
                </button>
              </li>
            }
          </ul>
          @if (total() > results().length) {
            <p class="border-t border-zinc-800 px-3 py-1.5 text-center text-[11px] text-zinc-600">
              Showing {{ results().length }} of {{ total() }} matches — keep typing to narrow them.
            </p>
          }
        }
      </div>
    </div>
  `,
})
export class FileFinder {
  /** The repository's files (path-sorted); supplied by the viewer. */
  readonly files = input.required<readonly TreeEntry[]>();

  /** A file was chosen — emits its path. */
  readonly fileSelect = output<string>();
  /** The finder was dismissed without choosing. */
  readonly closed = output<void>();

  protected readonly query = signal('');
  protected readonly activeIndex = signal(0);

  private readonly searchInput = viewChild.required<ElementRef<HTMLInputElement>>('search');
  private readonly listEl = viewChild<ElementRef<HTMLUListElement>>('list');

  /** Every file that matches the query (uncapped) — used for the count. */
  private readonly matches = computed(() => {
    const q = this.query().trim();
    const files = this.files();
    if (q === '') return files.map((entry) => ({ path: entry.path, positions: [] as number[] }));
    const ranked: { path: string; positions: readonly number[]; score: number }[] = [];
    for (const entry of files) {
      const match = fuzzyMatchPath(q, entry.path);
      if (match) ranked.push({ path: entry.path, positions: match.positions, score: match.score });
    }
    ranked.sort(
      (a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path),
    );
    return ranked;
  });

  protected readonly total = computed(() => this.matches().length);

  protected readonly results = computed<FinderResult[]>(() =>
    this.matches()
      .slice(0, MAX_RESULTS)
      .map(({ path, positions }) => toResult(path, positions)),
  );

  constructor() {
    afterNextRender(() => this.searchInput().nativeElement.focus());
  }

  protected onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.activeIndex.set(0);
  }

  protected onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.move(-1);
        break;
      case 'Enter': {
        event.preventDefault();
        const result = this.results()[this.activeIndex()];
        if (result) this.choose(result.path);
        break;
      }
      case 'Escape':
        event.preventDefault();
        this.closed.emit();
        break;
    }
  }

  protected onBackdrop(event: PointerEvent): void {
    // Only a click on the backdrop itself dismisses, not one inside the panel.
    if (event.target === event.currentTarget) this.closed.emit();
  }

  protected choose(path: string): void {
    this.fileSelect.emit(path);
  }

  private move(delta: number): void {
    const count = this.results().length;
    if (count === 0) return;
    const next = (this.activeIndex() + delta + count) % count;
    this.activeIndex.set(next);
    const row = this.listEl()?.nativeElement.children[next] as HTMLElement | undefined;
    row?.scrollIntoView?.({ block: 'nearest' });
  }
}

/** Splits a path into highlighted name and directory segments. */
function toResult(path: string, positions: readonly number[]): FinderResult {
  const slash = path.lastIndexOf('/');
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dir = slash >= 0 ? path.slice(0, slash) : '';
  const namePositions = positions.filter((p) => p > slash).map((p) => p - (slash + 1));
  const dirPositions = positions.filter((p) => p < slash);
  return {
    path,
    name: highlightSegments(name, namePositions),
    dir: dir ? highlightSegments(dir, dirPositions) : [],
  };
}
