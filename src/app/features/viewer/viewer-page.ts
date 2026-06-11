import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { RepoStore } from '../../core/store/repo-store';
import { relativeTime, shortSha } from '../../core/util/relative-time';
import { DiffView } from './diff-view';
import { FileHistory } from './file-history';
import { FileTree } from './file-tree';
import { FileView } from './file-view';

const TREE_WIDTH_KEY = 'time-tracer.tree-width';
const TREE_WIDTH_DEFAULT = 300;
const TREE_WIDTH_MIN = 200;
const TREE_WIDTH_MAX = 600;

/**
 * `/r/:owner/:repo?ref=…&path=…&at=…` — the split-pane repository viewer.
 *
 * The route is the source of truth: owner/repo/ref drive `RepoStore.loadRepo`,
 * `path` drives file selection and `at` views that file at a historical
 * commit, so deep links, refreshes and browser back/forward all behave like
 * real navigation — including steps through time.
 */
@Component({
  selector: 'app-viewer-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FileTree, FileView, FileHistory, DiffView],
  host: { class: 'block h-full' },
  template: `
    <div class="flex h-full flex-col" [class.select-none]="dragging()">
      <header
        class="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-900/60 px-4"
      >
        <a
          routerLink="/"
          class="flex shrink-0 items-center gap-2 text-zinc-100 transition hover:text-white"
        >
          <span
            class="flex size-6 items-center justify-center rounded-md border border-indigo-400/30 bg-indigo-500/10 text-indigo-300"
          >
            <svg
              class="size-3.5"
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
          </span>
          <span class="text-sm font-semibold tracking-tight">Time Tracer</span>
        </a>

        <span class="text-zinc-700">/</span>

        <div class="flex min-w-0 items-center gap-2">
          @if (store.linksFor(); as links) {
            <a
              class="truncate font-mono text-sm text-zinc-300 transition hover:text-white hover:underline"
              [href]="links.repoUrl"
              target="_blank"
              rel="noopener noreferrer"
              >{{ store.metadata()?.fullName ?? owner() + '/' + repo() }}</a
            >
          } @else {
            <span class="truncate font-mono text-sm text-zinc-300">{{ owner() }}/{{ repo() }}</span>
          }
          @if (store.ref(); as currentRef) {
            <span
              class="flex shrink-0 items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 font-mono text-[11px] text-zinc-400"
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
              {{ currentRef }}
            </span>
          }
        </div>

        <span class="flex-1"></span>

        @if (store.phase() === 'ready') {
          <span class="hidden shrink-0 text-xs text-zinc-500 md:block">
            {{ store.fileCount() }} files · {{ store.dirCount() }} folders
          </span>
          @if (store.truncated()) {
            <span
              class="shrink-0 rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-300"
              title="GitHub truncated the tree listing — some files may be missing."
            >
              partial tree
            </span>
          }
        }

        <a
          routerLink="/"
          class="shrink-0 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
        >
          New repository
        </a>
      </header>

      @if (store.phase() === 'error') {
        <div class="flex flex-1 items-center justify-center px-6">
          <div
            class="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center"
          >
            <div
              class="mx-auto mb-4 flex size-11 items-center justify-center rounded-full border border-rose-400/30 bg-rose-500/10 text-rose-300"
            >
              <svg
                class="size-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path
                  d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"
                />
                <path d="M12 9v4m0 4h.01" />
              </svg>
            </div>
            <h2 class="text-base font-semibold text-zinc-100">{{ errorTitle() }}</h2>
            <p class="mt-2 text-sm leading-6 text-zinc-400">{{ store.error()?.message }}</p>
            <div class="mt-6 flex items-center justify-center gap-3">
              <button
                type="button"
                class="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-400"
                (click)="store.retry()"
              >
                Try again
              </button>
              <a
                routerLink="/"
                class="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition hover:border-zinc-500"
              >
                Another repository
              </a>
            </div>
          </div>
        </div>
      } @else if (store.phase() !== 'ready') {
        <div class="flex flex-1 flex-col items-center justify-center gap-4 text-zinc-400">
          <svg
            class="size-7 animate-spin text-indigo-300"
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
          <p class="text-sm">
            {{ store.phase() === 'tree' ? 'Loading file tree…' : 'Fetching repository metadata…' }}
          </p>
        </div>
      } @else {
        <div class="flex min-h-0 flex-1">
          <aside
            class="slim-scrollbar shrink-0 overflow-x-hidden overflow-y-auto border-r border-zinc-800 bg-zinc-950 py-2 pr-1 pl-1"
            [style.width.px]="treeWidth()"
          >
            @if (store.tree().length === 0) {
              <p class="px-3 py-2 text-xs text-zinc-600">This repository has no files.</p>
            } @else {
              <app-file-tree
                [nodes]="store.tree()"
                [selectedPath]="store.selectedPath()"
                [expanded]="store.expandedDirs()"
                (fileSelect)="onFileSelect($event)"
                (dirToggle)="store.toggleDir($event)"
              />
            }
          </aside>

          <div
            class="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-indigo-400/40"
            [class.bg-indigo-400/40]="dragging()"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file tree"
            (pointerdown)="onDragStart($event)"
            (pointermove)="onDragMove($event)"
            (pointerup)="onDragEnd()"
            (pointercancel)="onDragEnd()"
            (dblclick)="resetTreeWidth()"
          ></div>

          <section class="flex min-w-0 flex-1 flex-col bg-zinc-950">
            @if (store.viewAt(); as at) {
              <div
                class="flex shrink-0 items-center gap-2 border-b border-amber-400/20 bg-amber-400/10 px-4 py-1.5 text-xs text-amber-200"
              >
                <svg
                  class="size-3.5 shrink-0"
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
                <span class="min-w-0 truncate">
                  Viewing at
                  @if (store.viewAtCommit(); as commit) {
                    <a
                      class="font-mono underline-offset-2 hover:underline"
                      [href]="commit.htmlUrl"
                      target="_blank"
                      rel="noopener noreferrer"
                      >{{ abbrev(at) }}</a
                    >
                    — {{ commit.summary }}
                    <span class="text-amber-200/60">
                      · {{ commit.authorName }} · {{ when(commit.authoredAt) }}</span
                    >
                  } @else {
                    <span class="font-mono">{{ abbrev(at) }}</span>
                  }
                </span>
                <span class="flex-1"></span>
                <div
                  class="flex shrink-0 overflow-hidden rounded border border-amber-300/30"
                  role="group"
                  aria-label="View mode"
                >
                  <button
                    type="button"
                    class="px-2 py-0.5 transition"
                    [class]="!diffMode() ? 'bg-amber-300/25 font-medium' : 'hover:bg-amber-300/10'"
                    (click)="setDiffMode(false)"
                  >
                    File
                  </button>
                  <button
                    type="button"
                    class="border-l border-amber-300/30 px-2 py-0.5 transition"
                    [class]="diffMode() ? 'bg-amber-300/25 font-medium' : 'hover:bg-amber-300/10'"
                    (click)="setDiffMode(true)"
                  >
                    Changes
                  </button>
                </div>
                <button
                  type="button"
                  class="shrink-0 rounded border border-amber-300/30 px-2 py-0.5 transition enabled:hover:bg-amber-300/10 disabled:opacity-40"
                  [disabled]="olderSha() === undefined"
                  (click)="goToCommit(olderSha() ?? null)"
                  title="One commit older"
                >
                  ← Older
                </button>
                <button
                  type="button"
                  class="shrink-0 rounded border border-amber-300/30 px-2 py-0.5 transition enabled:hover:bg-amber-300/10 disabled:opacity-40"
                  [disabled]="newerSha() === undefined"
                  (click)="goToCommit(newerSha() ?? null)"
                  title="One commit newer"
                >
                  Newer →
                </button>
                <button
                  type="button"
                  class="shrink-0 rounded bg-amber-300/15 px-2 py-0.5 font-medium transition hover:bg-amber-300/25"
                  (click)="goToCommit(null)"
                >
                  Back to {{ store.ref() }}
                </button>
              </div>
            }
            @if (diffMode()) {
              <app-diff-view
                class="min-h-0 flex-1"
                [state]="store.selectedDiff()"
                [path]="store.selectedPath()"
                (retry)="onDiffRetry()"
              />
            } @else {
              <app-file-view
                class="min-h-0 flex-1"
                [state]="store.selectedFile()"
                [links]="selectedFileLinks()"
                [historyActive]="historyOpen()"
                (retry)="onFileRetry($event)"
                (historyToggle)="toggleHistory()"
              />
            }
          </section>

          @if (historyOpen()) {
            <aside class="w-80 shrink-0 border-l border-zinc-800 bg-zinc-950">
              <app-file-history
                [path]="store.selectedPath()"
                [tipRef]="store.ref()"
                [commits]="store.history()"
                [status]="store.historyStatus()"
                [error]="store.historyError()"
                [hasMore]="store.historyHasMore()"
                [selectedSha]="store.viewAt()"
                (commitSelect)="goToCommit($event)"
                (loadMore)="store.loadMoreHistory()"
                (retry)="store.retryHistory()"
                (closed)="toggleHistory()"
              />
            </aside>
          }
        </div>
      }
    </div>
  `,
})
export class ViewerPage {
  protected readonly store = inject(RepoStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly title = inject(Title);

  /** Bound from the route by `withComponentInputBinding`. */
  readonly owner = input.required<string>();
  readonly repo = input.required<string>();
  readonly ref = input<string | undefined>();
  readonly path = input<string | undefined>();
  /** Commit sha the selected file is viewed at (time travel). */
  readonly at = input<string | undefined>();
  /** `diff` switches the content pane to the changes view (requires `at`). */
  readonly view = input<string | undefined>();

  protected readonly treeWidth = signal(restoreTreeWidth());
  protected readonly dragging = signal(false);
  protected readonly historyOpen = signal(false);
  private dragOrigin: { x: number; width: number } | null = null;
  /** The panel auto-opens only for the first `at` deep link, not every hop. */
  private historyAutoOpened = false;

  protected readonly diffMode = computed(() => this.view() === 'diff' && !!this.store.viewAt());

  protected readonly selectedFileLinks = computed(() => {
    const path = this.store.selectedPath();
    if (!path) return null;
    return this.store.linksFor(path, this.store.viewAt());
  });

  /** Next-older commit sha; undefined = unknown/none (disables the button). */
  protected readonly olderSha = computed<string | null | undefined>(() => {
    const at = this.store.viewAt();
    if (!at) return undefined;
    const history = this.store.history();
    const idx = history.findIndex((c) => c.sha === at);
    if (idx === -1 || idx + 1 >= history.length) return undefined;
    return history[idx + 1].sha;
  });

  /** Next-newer commit sha; null = back to the snapshot tip. */
  protected readonly newerSha = computed<string | null | undefined>(() => {
    const at = this.store.viewAt();
    if (!at) return undefined;
    const history = this.store.history();
    const idx = history.findIndex((c) => c.sha === at);
    if (idx === -1) return undefined;
    return idx === 0 ? null : history[idx - 1].sha;
  });

  protected readonly errorTitle = computed(() => {
    switch (this.store.error()?.kind) {
      case 'rate-limited':
        return 'GitHub rate limit reached';
      case 'not-found':
        return 'Repository not found';
      case 'invalid-ref':
        return 'Ref not found';
      case 'empty-repo':
        return 'Empty repository';
      case 'network':
        return 'Network problem';
      default:
        return 'Something went wrong';
    }
  });

  constructor() {
    effect(() => {
      const owner = this.owner();
      const repo = this.repo();
      const ref = this.ref() || undefined;
      untracked(() => void this.store.loadRepo({ provider: 'github', owner, repo }, ref));
    });

    effect(() => {
      const phase = this.store.phase();
      const path = this.path() || null;
      const at = this.at() || null;
      untracked(() => {
        if (phase !== 'ready') return;
        if (path) {
          void this.store.openFile(path, at);
          if (at && !this.historyAutoOpened) {
            this.historyAutoOpened = true;
            this.historyOpen.set(true);
          }
        } else {
          this.store.clearSelection();
        }
      });
    });

    effect(() => {
      const phase = this.store.phase();
      const open = this.historyOpen();
      const path = this.store.selectedPath();
      untracked(() => {
        if (phase === 'ready' && open && path) void this.store.loadHistory(path);
      });
    });

    effect(() => {
      const phase = this.store.phase();
      const diff = this.diffMode();
      const path = this.path() || null;
      const at = this.at() || null;
      untracked(() => {
        if (phase === 'ready' && diff && path && at) void this.store.loadDiff(path, at);
      });
    });

    effect(() => {
      const fullName = this.store.metadata()?.fullName;
      if (fullName) this.title.setTitle(`${fullName} · Time Tracer`);
    });
  }

  protected onFileSelect(path: string): void {
    // Switching files always returns to the snapshot tip: `at` and `view`
    // belong to the previous file's timeline.
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { path, at: null, view: null },
      queryParamsHandling: 'merge',
    });
  }

  /** Switches the content pane between file and changes mode (URL-driven). */
  protected setDiffMode(enabled: boolean): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { view: enabled ? 'diff' : null },
      queryParamsHandling: 'merge',
    });
  }

  protected onDiffRetry(): void {
    const path = this.store.selectedPath();
    const at = this.store.viewAt();
    if (path && at) void this.store.loadDiff(path, at);
  }

  /** Navigates the selected file to `sha`, or back to the tip when null. */
  protected goToCommit(sha: string | null): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { at: sha },
      queryParamsHandling: 'merge',
    });
  }

  protected toggleHistory(): void {
    this.historyOpen.update((open) => !open);
  }

  protected onFileRetry(path: string): void {
    void this.store.openFile(path, this.store.viewAt());
  }

  protected abbrev(sha: string): string {
    return shortSha(sha);
  }

  protected when(iso: string): string {
    return relativeTime(iso);
  }

  protected onDragStart(event: PointerEvent): void {
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.dragOrigin = { x: event.clientX, width: this.treeWidth() };
    this.dragging.set(true);
  }

  protected onDragMove(event: PointerEvent): void {
    if (!this.dragOrigin) return;
    const width = this.dragOrigin.width + event.clientX - this.dragOrigin.x;
    this.treeWidth.set(Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, width)));
  }

  protected onDragEnd(): void {
    if (!this.dragOrigin) return;
    this.dragOrigin = null;
    this.dragging.set(false);
    persistTreeWidth(this.treeWidth());
  }

  protected resetTreeWidth(): void {
    this.treeWidth.set(TREE_WIDTH_DEFAULT);
    persistTreeWidth(TREE_WIDTH_DEFAULT);
  }
}

function restoreTreeWidth(): number {
  try {
    const stored = Number(localStorage.getItem(TREE_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= TREE_WIDTH_MIN && stored <= TREE_WIDTH_MAX) {
      return stored;
    }
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  return TREE_WIDTH_DEFAULT;
}

function persistTreeWidth(width: number): void {
  try {
    localStorage.setItem(TREE_WIDTH_KEY, String(width));
  } catch {
    // Best-effort only.
  }
}
