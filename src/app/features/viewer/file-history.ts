import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { CommitInfo } from '../../core/models';
import {
  HistoryStatus,
  HunkOriginCandidate,
  HunkOriginScope,
  HunkOriginState,
  LineTraceHit,
  LineTraceState,
  RenameCandidate,
  RenameState,
} from '../../core/store/repo-store';
import { RelatedFile } from '../../core/util/co-change';
import { LineRange } from '../../core/util/line-range';
import { relativeTime, shortSha } from '../../core/util/relative-time';
import { traceToMarkdown } from '../../core/util/trace-export';
import { CopyButton } from './copy-button';

/**
 * Commit history of the selected file. Clicking a commit shows the file as it
 * was at that commit ("time travel"); the top row returns to the snapshot ref.
 * Like `git log -- <path>`, the list stops at renames — continuing past them
 * is the upcoming rename-candidates milestone.
 *
 * While a line trace is active (a hunk's "Trace"), the list shows only the
 * commits that changed the traced lines, with a banner to clear the filter.
 * Where the trace ends, the origin search looks for the place the lines may
 * have moved from — first among the introducing commit's other files, then
 * across the whole snapshot before it.
 */
@Component({
  selector: 'app-file-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex h-full min-h-0 flex-col' },
  imports: [CopyButton],
  template: `
    <header class="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3">
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

        @if (!trace() && related().length) {
          <div class="border-t border-zinc-800/50 px-3 py-2">
            <p
              class="mb-1 text-[10px] font-medium tracking-wide text-zinc-500 uppercase"
              title="Files that changed in the same commits as this one (from Insights)"
            >
              Often changes with
            </p>
            @for (rel of related(); track rel.path) {
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
                [title]="rel.path"
                (click)="relatedSelect.emit(rel.path)"
              >
                <span class="min-w-0 flex-1 truncate font-mono">{{ fileName(rel.path) }}</span>
                <span class="shrink-0 text-zinc-600">{{ pct(rel.confidence) }}%</span>
              </button>
            }
          </div>
        }

        @if (trace(); as t) {
          <div class="border-t border-zinc-800/50 bg-indigo-500/10 px-3 py-2">
            <div class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate text-[11px] font-medium text-indigo-200">
                Tracing {{ rangeLabel(t) }}
                <span class="font-mono font-normal text-indigo-300/70">
                  @ {{ abbrev(t.anchorSha) }}</span
                >
              </span>
              @if (t.commits.length > 0) {
                <app-copy-button
                  [value]="traceMarkdown(t)"
                  label="Copy"
                  title="Copy this trace as Markdown"
                  buttonClass="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-indigo-300/80 transition hover:bg-white/10 hover:text-indigo-100"
                />
              }
              <button
                type="button"
                class="shrink-0 rounded p-0.5 text-indigo-300/70 transition hover:bg-white/10 hover:text-indigo-100"
                (click)="traceClear.emit()"
                aria-label="Stop tracing"
                title="Show the full history again"
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
            </div>
            <p class="mt-0.5 text-[10px] leading-4 text-indigo-300/60">
              Only commits that changed these lines.
            </p>
          </div>

          @if (t.status === 'error') {
            <p class="px-3 py-2 text-xs leading-5 text-rose-400">{{ t.message }}</p>
          }
          @for (hit of t.hits; track hit.commit.sha + ':' + hit.path) {
            <button
              type="button"
              class="block w-full border-t border-zinc-800/50 px-3 py-2 text-left transition-colors"
              [class]="
                selectedSha() === hit.commit.sha
                  ? 'bg-indigo-500/15 text-zinc-100'
                  : 'text-zinc-400 hover:bg-white/5'
              "
              (click)="traceSelect.emit(hit)"
            >
              <span class="block truncate text-xs" [title]="hit.commit.summary">{{
                hit.commit.summary
              }}</span>
              <span class="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-500">
                <span class="font-mono">{{ abbrev(hit.commit.sha) }}</span>
                <span class="truncate">{{ hit.commit.authorName }}</span>
                <span class="shrink-0 text-indigo-300/70">{{ rangeLabel(hit.range) }}</span>
                @if (hit.path !== path()) {
                  <span class="truncate font-mono text-zinc-600">{{ hit.path }}</span>
                }
                <span class="ml-auto shrink-0">{{ when(hit.commit.authoredAt) }}</span>
              </span>
            </button>
          }
          @if (t.status === 'computing') {
            <p
              class="animate-pulse border-t border-zinc-800/50 px-3 py-2 text-[11px] text-zinc-500"
            >
              Searching the history… ({{ t.scanned }} examined)
            </p>
          } @else if (t.status === 'ready') {
            @if (t.truncated) {
              <button
                type="button"
                class="mx-3 my-2 rounded border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 transition hover:border-zinc-500"
                (click)="traceOlder.emit()"
              >
                Search older commits
              </button>
            } @else if (t.commits.length > 0) {
              <div class="border-t border-zinc-800/50 px-3 py-2">
                <p class="text-[11px] leading-4 text-zinc-600">
                  The oldest commit above introduced these lines.
                </p>
                @if (t.origin) {
                  @if (origins(); as o) {
                    @switch (o.status) {
                      @case ('searching') {
                        <p class="mt-1.5 animate-pulse text-[11px] text-zinc-500">
                          Comparing files… ({{ o.scanned }}/{{ o.total }})
                        </p>
                      }
                      @case ('unavailable') {
                        <p class="mt-1.5 text-[11px] leading-4 text-zinc-500">{{ o.message }}</p>
                      }
                      @case ('error') {
                        <p class="mt-1.5 text-[11px] text-rose-400">{{ o.message }}</p>
                        <button
                          type="button"
                          class="mt-1 rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 transition hover:border-zinc-500"
                          (click)="searchOrigins.emit(o.scope)"
                        >
                          Try again
                        </button>
                      }
                    }
                    @for (candidate of o.candidates; track candidate.path) {
                      <div class="mt-1 flex items-stretch gap-1">
                        <button
                          type="button"
                          class="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 text-left transition hover:border-indigo-400/40 hover:bg-indigo-500/10"
                          title="Open this file just before the commit, at the matched line"
                          (click)="originSelect.emit(candidate)"
                        >
                          <span class="block truncate font-mono text-[11px] text-zinc-200">{{
                            candidate.path
                          }}</span>
                          <span class="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                            <span
                              class="text-indigo-300"
                              title="How much of the traced block matches at this line"
                              >{{ percent(candidate.score) }} match</span
                            >
                            <span class="text-zinc-500">line {{ candidate.line }}</span>
                            <span
                              class="text-zinc-400"
                              title="How much of this whole file matches the traced file — higher means a likelier original source"
                              >{{ percent(candidate.fileSimilarity) }} of file</span
                            >
                            @if (candidate.deleted) {
                              <span class="rounded-full border border-zinc-700 px-1.5 text-zinc-500"
                                >deleted</span
                              >
                            }
                          </span>
                        </button>
                        <button
                          type="button"
                          class="shrink-0 self-stretch rounded border border-zinc-800 bg-zinc-900/60 px-2 text-[11px] font-medium text-indigo-200 transition hover:border-indigo-400/40 hover:bg-indigo-500/10"
                          title="Diff the introduced lines against this source"
                          (click)="originDiff.emit(candidate)"
                        >
                          Diff
                        </button>
                      </div>
                    }
                    @if (o.status === 'ready') {
                      @if (o.candidates.length === 0) {
                        <p class="mt-1.5 text-[11px] leading-4 text-zinc-500">
                          {{
                            o.scope === 'commit'
                              ? "No likely source among the commit's other files."
                              : 'No likely source found in the snapshot before the commit.'
                          }}
                        </p>
                      }
                      @if (o.scope === 'commit') {
                        <button
                          type="button"
                          class="mt-1.5 rounded border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 transition hover:border-zinc-500"
                          title="Compare every file as the repository was just before this commit (capped)"
                          (click)="searchOrigins.emit('snapshot')"
                        >
                          Search the whole snapshot
                        </button>
                      } @else if (o.capped) {
                        <p class="mt-1 text-[10px] leading-4 text-zinc-600">
                          Capped search — closest-named files only.
                        </p>
                      }
                    }
                  } @else {
                    <button
                      type="button"
                      class="mt-1.5 rounded border border-indigo-400/30 bg-indigo-500/10 px-2.5 py-1 text-[11px] text-indigo-200 transition hover:bg-indigo-500/20"
                      title="Search the commit's other files for where this block may have moved from"
                      (click)="searchOrigins.emit('commit')"
                    >
                      Where did these lines come from?
                    </button>
                  }
                }
              </div>
            } @else {
              <p class="px-3 py-2 text-xs text-zinc-600">No commits changed these lines.</p>
            }
          }
        } @else {
          @switch (status()) {
            @case ('loading') {
              <div class="space-y-2 p-3" aria-label="Loading history">
                @for (width of [85, 60, 75, 50, 80]; track $index) {
                  <div
                    class="h-3 animate-pulse rounded bg-zinc-800/80"
                    [style.width.%]="width"
                  ></div>
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
                <div class="mx-3 my-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    class="rounded border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 transition hover:border-zinc-500"
                    (click)="loadMore.emit()"
                  >
                    Load older commits
                  </button>
                  <button
                    type="button"
                    class="rounded border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 transition hover:border-zinc-500"
                    title="Page in every remaining commit at once"
                    (click)="loadAll.emit()"
                  >
                    Load all
                  </button>
                </div>
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
                            <div class="mt-1 flex items-stretch gap-1">
                              <button
                                type="button"
                                class="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 text-left transition hover:border-indigo-400/40 hover:bg-indigo-500/10"
                                title="Continue in this file's own timeline"
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
                              <button
                                type="button"
                                class="shrink-0 self-stretch rounded border border-zinc-800 bg-zinc-900/60 px-2 text-[11px] font-medium text-indigo-200 transition hover:border-indigo-400/40 hover:bg-indigo-500/10"
                                title="Diff the current file against this predecessor"
                                (click)="candidateDiff.emit(candidate)"
                              >
                                Diff
                              </button>
                            </div>
                          }
                        }
                      }
                    }
                  }
                </div>
              }
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
  /** Active line trace — replaces the list with the filtered commits. */
  readonly trace = input<LineTraceState | null>(null);
  /** Origin search of the finished trace, once started. */
  readonly origins = input<HunkOriginState | null>(null);
  /** Files coupled to this one (from the co-change analysis); empty until run. */
  readonly related = input<readonly RelatedFile[]>([]);

  readonly commitSelect = output<string | null>();
  /** A coupled file was picked — open it. */
  readonly relatedSelect = output<string>();
  readonly traceSelect = output<LineTraceHit>();
  readonly loadMore = output<void>();
  /** "Load all": page in every remaining commit at once. */
  readonly loadAll = output<void>();
  readonly retry = output<void>();
  readonly closed = output<void>();
  readonly findRenames = output<void>();
  readonly candidateSelect = output<RenameCandidate>();
  /** "Diff" on a candidate: compare the current file against that predecessor. */
  readonly candidateDiff = output<RenameCandidate>();
  readonly traceClear = output<void>();
  readonly traceOlder = output<void>();
  readonly searchOrigins = output<HunkOriginScope>();
  readonly originSelect = output<HunkOriginCandidate>();
  /** "Diff" on an origin candidate: compare the introduced block against it. */
  readonly originDiff = output<HunkOriginCandidate>();

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
      case 'deleted-in-commit':
        return 'deleted';
      case 'identical-content':
        return 'identical';
      case 'similar-content':
        return 'similar';
      default:
        return 'name/size';
    }
  }

  protected rangeLabel(range: LineRange | LineTraceState): string {
    const { start, end } = 'range' in range ? range.range : range;
    return start === end ? `line ${start}` : `lines ${start}–${end}`;
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

  protected pct(fraction: number): number {
    return Math.round(fraction * 100);
  }

  protected traceMarkdown(trace: LineTraceState): string {
    return traceToMarkdown(trace);
  }
}
