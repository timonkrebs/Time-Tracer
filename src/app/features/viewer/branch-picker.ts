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

import { BranchesState } from '../../core/store/repo-store';

/**
 * The header's branch selector: a chip showing the current ref that opens a
 * filterable dropdown of the repository's branches. The list loads lazily on
 * the first open (via `load`), so just browsing never spends the request;
 * picking a branch emits `refSelect` and the viewer navigates through the
 * `ref` query param.
 */
@Component({
  selector: 'app-branch-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'relative block shrink-0',
    '(document:click)': 'onDocumentClick($event)',
    '(keydown.escape)': 'onEscape($event)',
  },
  template: `
    <button
      #toggleButton
      type="button"
      class="flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
      (click)="toggle()"
      aria-haspopup="listbox"
      [attr.aria-expanded]="open()"
      [attr.aria-label]="'Switch branch — viewing ' + ref()"
      title="Switch branch"
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
      <span class="max-w-48 truncate">{{ ref() }}</span>
      <svg
        class="size-3 transition-transform"
        [class.rotate-180]="open()"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>

    @if (open()) {
      <div
        class="absolute top-full left-0 z-50 mt-1 flex w-72 flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
      >
        @if (state()?.status === 'ready') {
          <div class="flex items-center gap-2 border-b border-zinc-800 px-3">
            <svg
              class="size-3.5 shrink-0 text-zinc-500"
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
              #filterInput
              type="text"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              placeholder="Find a branch…"
              aria-label="Branch name"
              class="h-9 min-w-0 flex-1 bg-transparent text-xs text-zinc-100 outline-none placeholder:text-zinc-600"
              [value]="filter()"
              (input)="onFilterInput($event)"
              (keydown)="onFilterKeydown($event)"
            />
          </div>
          @if (branches().length === 0) {
            <p class="px-3 py-4 text-center text-xs text-zinc-500">
              {{ filter().trim() ? 'No branches match.' : 'No branches found.' }}
            </p>
          } @else {
            <ul
              #list
              role="listbox"
              aria-label="Branches"
              class="slim-scrollbar max-h-72 min-h-0 overflow-y-auto py-1"
            >
              @for (name of branches(); track name; let i = $index) {
                <li>
                  <button
                    type="button"
                    role="option"
                    class="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs transition-colors"
                    [class]="i === activeIndex() ? 'bg-indigo-500/20' : 'hover:bg-white/5'"
                    [attr.aria-selected]="name === ref()"
                    (pointermove)="activeIndex.set(i)"
                    (click)="choose(name)"
                  >
                    <span
                      class="w-3 shrink-0"
                      [class.text-indigo-300]="name === ref()"
                      aria-hidden="true"
                      >{{ name === ref() ? '✓' : '' }}</span
                    >
                    <span class="min-w-0 flex-1 truncate text-zinc-200">{{ name }}</span>
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
            @if (truncated()) {
              <p class="border-t border-zinc-800 px-3 py-1.5 text-center text-[10px] text-zinc-600">
                Only the first {{ total() }} branches are listed.
              </p>
            }
          }
        } @else if (state()?.status === 'error') {
          <div class="px-3 py-3 text-xs">
            <p class="text-rose-300">{{ errorMessage() }}</p>
            <button
              type="button"
              class="mt-2 rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
              (click)="load.emit()"
            >
              Try again
            </button>
          </div>
        } @else {
          <p class="flex items-center gap-2 px-3 py-3 text-xs text-zinc-500">
            <svg
              class="size-3.5 animate-spin text-indigo-300"
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
            Loading branches…
          </p>
        }
      </div>
    }
  `,
})
export class BranchPicker {
  /** Ref currently shown in the viewer (branch, tag or sha). */
  readonly ref = input.required<string>();
  /** The repository's default branch — pinned first and badged. */
  readonly defaultBranch = input<string | null>(null);
  /** Branch list state from the store; null until first requested. */
  readonly state = input<BranchesState | null>(null);

  /** The dropdown was opened (or "Try again" pressed) — load the list. */
  readonly load = output<void>();
  /** A branch was chosen — emits its name. */
  readonly refSelect = output<string>();

  protected readonly open = signal(false);
  protected readonly filter = signal('');
  protected readonly activeIndex = signal(0);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly filterInput = viewChild<ElementRef<HTMLInputElement>>('filterInput');
  private readonly listEl = viewChild<ElementRef<HTMLUListElement>>('list');
  private readonly toggleButton = viewChild.required<ElementRef<HTMLButtonElement>>('toggleButton');

  /** Branches to show: filtered, with the default branch pinned first. */
  protected readonly branches = computed<readonly string[]>(() => {
    const state = this.state();
    if (state?.status !== 'ready') return [];
    const query = this.filter().trim().toLowerCase();
    const names = query
      ? state.names.filter((name) => name.toLowerCase().includes(query))
      : state.names;
    const pinned = this.defaultBranch();
    if (!pinned || !names.includes(pinned)) return names;
    return [pinned, ...names.filter((name) => name !== pinned)];
  });

  protected readonly truncated = computed(() => {
    const state = this.state();
    return state?.status === 'ready' && state.truncated;
  });

  protected readonly total = computed(() => {
    const state = this.state();
    return state?.status === 'ready' ? state.names.length : 0;
  });

  protected readonly errorMessage = computed(() => {
    const state = this.state();
    return state?.status === 'error' ? state.message : '';
  });

  constructor() {
    // The filter input only exists once the dropdown is open and the list is
    // ready; focus it as soon as it appears.
    effect(() => {
      if (this.open()) this.filterInput()?.nativeElement.focus();
    });
  }

  protected toggle(): void {
    if (this.open()) {
      this.open.set(false);
      return;
    }
    this.filter.set('');
    this.activeIndex.set(0);
    this.open.set(true);
    this.load.emit();
  }

  protected choose(name: string): void {
    this.open.set(false);
    this.refSelect.emit(name);
  }

  protected onFilterInput(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
    this.activeIndex.set(0);
  }

  protected onFilterKeydown(event: KeyboardEvent): void {
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
        const name = this.branches()[this.activeIndex()];
        if (name) this.choose(name);
        break;
      }
    }
  }

  /** Esc closes the dropdown (and stays out of the viewer's global keymap). */
  protected onEscape(event: Event): void {
    if (!this.open()) return;
    event.preventDefault();
    this.open.set(false);
    this.toggleButton().nativeElement.focus();
  }

  /** A click anywhere outside the picker dismisses the dropdown. */
  protected onDocumentClick(event: MouseEvent): void {
    if (!this.open()) return;
    if (!this.host.nativeElement.contains(event.target as Node)) this.open.set(false);
  }

  private move(delta: number): void {
    const count = this.branches().length;
    if (count === 0) return;
    const next = (this.activeIndex() + delta + count) % count;
    this.activeIndex.set(next);
    const row = this.listEl()?.nativeElement.children[next] as HTMLElement | undefined;
    row?.scrollIntoView?.({ block: 'nearest' });
  }
}
