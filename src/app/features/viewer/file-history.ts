import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { CommitInfo } from '../../core/models';
import { HistoryStatus, RenameCandidate, RenameState } from '../../core/store/repo-store';
import { relativeTime, shortSha } from '../../core/util/relative-time';

/**
 * Commit history of the selected file. Clicking a commit shows the file as it
 * was at that commit ("time travel"); the top row returns to the snapshot ref.
 * Like `git log -- <path>`, the list stops at renames — continuing past them
 * is the upcoming rename-candidates milestone.
 */
@Component({
  selector: 'app-file-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <header
      class="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3"
    >
      <svg
        class="size-3.5 shrink-0 text-indigo-300"
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
      <h2 class="min-w-0 flex-1 truncate text-xs font-medium text-zinc-300">
        History
        @if (path(); as p) {
          <span class="text-zinc-500"> — {{ fileName(p) }}</span>
        }
      </h2>
      <button
        type="button"
        class="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
        (click)="closed.emit()"
        aria-label="Close history panel"
      >
        <svg
          class="size-3.5"
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
    </header>

    @if (!path()) {
      <p class="p-4 text-xs leading-5 text-zinc-600">
        Select a file to see the commits that changed it.
      </p>
    } @else {
      <div class="slim-scrollbar min-h-0 flex-1 overflow-y-auto py-1">
        <button
          type="button"
          class="block w-full px-3 py-2 text-left transition-colors"
          [class]="
            selectedSha() === null
              ? 'bg-indigo-500/15 text-zinc-100'
              : 'text-zinc-400 hover:bg-white/5'
          "
          (click)="commitSelect.emit(null)"
        >
          <span class="block truncate text-xs font-medium">Current version</span>
          <span class="mt-0.5 block font-mono text-[11px] text-zinc-500">{{ tipRef() }}</span>
        </button>

        @switch (status()) {
          @case ('loading') {
            <div class="space-y-2 p-3" aria-label="Loading history">
              @for (width of [85, 60, 75, 50, 80]; track $index) {
                <div class="h-3 animate-pulse rounded bg-zinc-800/80" [style.width.%]="width"></div>
              }
            </div>
          }
          @case ('error') {
            <div class="flex flex-col items-start gap-2 px-3 py-3">
              <p class="text-xs leading-5 text-rose-400">{{ error() }}</p>
              <button
                type="button"
                class="rounded border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 transition hover:border-zinc-500"
                (click)="retry.emit()"
              >
                Try again
              </button>
            </div>
          }
          @default {
            @if (commits().length === 0 && status() === 'ready') {
              <p class="px-3 py-2 text-xs text-zinc-600">No commits found for this file.</p>
            }
            @for (commit of commits(); track commit.sha) {
              <button
                type="button"
                class="block w-full border-t border-zinc-800/50 px-3 py-2 text-left transition-colors"
                [class]="
                  selectedSha() === commit.sha
                    ? 'bg-indigo-500/15 text-zinc-100'
                    : 'text-zinc-400 hover:bg-white/5'
                "
                (click)="commitSelect.emit(commit.sha)"
              >
                <span class="block truncate text-xs" [title]="commit.summary">{{
                  commit.summary
                }}</span>
                <span class="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-500">
                  <span class="font-mono">{{ abbrev(commit.sha) }}</span>
                  <span class="truncate">{{ commit.authorName }}</span>
                  <span class="ml-auto shrink-0">{{ when(commit.authoredAt) }}</span>
                </span>
              </button>
            }
            @if (status() === 'loading-more') {
              <p class="px-3 py-2 text-center text-[11px] text-zinc-500">Loading…</p>
            } @else if (hasMore()) {
              <button
                type="button"
                class="mx-3 my-2 rounded border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 transition hover:border-zinc-500"
                (click)="loadMore.emit()"
              >
                Load older commits
              </button>
            } @else if (commits().length > 0) {
              <div class="border-t border-zinc-800/50 px-3 py-2">
                <p class="text-[11px] leading-4 text-zinc-600">
                  Start of this path's recorded history.
                </p>
                @if (!renames()) {
                  <button
                    type="button"
                    class="mt-1.5 rounded border border-indigo-400/30 bg-indigo-500/10 px-2.5 py-1 text-[11px] text-indigo-200 transition hover:bg-indigo-500/20"
                    title="Search the commit just before for files this one may have been renamed from"
                    (click)="findRenames.emit()"
                  >
                    Continue past the rename?
                  </button>
                } @else {
                  @switch (renames()!.status) {
                    @case ('loading') {
                      <p class="mt-1.5 animate-pulse text-[11px] text-zinc-500">
                        Searching for predecessors…
                      </p>
                    }
                    @case ('unavailable') {
                      <p class="mt-1.5 text-[11px] leading-4 text-zinc-500">
                        {{ unavailableReason() }}
                      </p>
                    }
                    @case ('error') {
                      <p class="mt-1.5 text-[11px] text-rose-400">{{ errorMessage() }}</p>
                      <button
                        type="button"
                        class="mt-1 rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 transition hover:border-zinc-500"
                        (click)="findRenames.emit()"
                      >
                        Try again
                      </button>
                    }
                    @case ('ready') {
                      @if (readyCandidates().length === 0) {
                        <p class="mt-1.5 text-[11px] leading-4 text-zinc-500">
                          No likely predecessors found in the parent commit.
                        </p>
                      } @else {
                        <p class="mt-1.5 text-[11px] text-zinc-500">Continue in:</p>
                        @for (candidate of readyCandidates(); track candidate.path) {
                          <button
                            type="button"
                            class="mt-1 block w-full rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 text-left transition hover:border-indigo-400/40 hover:bg-indigo-500/10"
                            (click)="candidateSelect.emit(candidate)"
                          >
                            <span class="block truncate font-mono text-[11px] text-zinc-200">{{
                              candidate.path
                            }}</span>
                            <span class="mt-0.5 flex items-center gap-1.5 text-[10px]">
                              <span class="text-indigo-300"
                                >{{ percent(candidate.confidence) }} match</span
                              >
                              @for (reason of candidate.reasons; track reason) {
                                <span
                                  class="rounded-full border border-zinc-700 px-1.5 text-zinc-500"
                                  >{{ reasonLabel(reason) }}</span
                                >
                              }
                            </span>
                          </button>
                        }
                      }
                    }
                  }
                }
              </div>
            }
          }
        }
      </div>
    }
  `,
})
export class FileHistory {
  readonly path = input.required<string | null>();
  readonly tipRef = input.required<string | null>();
  readonly commits = input.required<readonly CommitInfo[]>();
  readonly status = input.required<HistoryStatus>();
  readonly error = input<string | null>(null);
  readonly hasMore = input(false);
  /** Sha currently viewed, or null for the snapshot tip. */
  readonly selectedSha = input<string | null>(null);
  /** Rename-candidate search state for the path, once started. */
  readonly renames = input<RenameState | null>(null);

  readonly commitSelect = output<string | null>();
  readonly loadMore = output<void>();
  readonly retry = output<void>();
  readonly closed = output<void>();
  readonly findRenames = output<void>();
  readonly candidateSelect = output<RenameCandidate>();

  protected unavailableReason(): string {
    const state = this.renames();
    return state?.status === 'unavailable' ? state.reason : '';
  }

  protected errorMessage(): string {
    const state = this.renames();
    return state?.status === 'error' ? state.message : '';
  }

  protected readyCandidates(): readonly RenameCandidate[] {
    const state = this.renames();
    return state?.status === 'ready' ? state.candidates : [];
  }

  protected percent(confidence: number): string {
    return `${Math.round(confidence * 100)}%`;
  }

  protected reasonLabel(reason: RenameCandidate['reasons'][number]): string {
    switch (reason) {
      case 'github-rename':
        return 'rename';
      case 'identical-content':
        return 'identical';
      case 'similar-content':
        return 'similar';
      default:
        return 'name/size';
    }
  }

  protected abbrev(sha: string): string {
    return shortSha(sha);
  }

  protected when(iso: string): string {
    return relativeTime(iso);
  }

  protected fileName(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
  }
}
