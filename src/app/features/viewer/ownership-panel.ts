import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import { FolderOwnershipState } from '../../core/store/repo-store';
import { FileRisk, OwnershipSummary } from '../../core/util/ownership';
import { relativeTime, shortDate } from '../../core/util/relative-time';

/** Top authors shown before collapsing the rest into a "+N more" line. */
const MAX_AUTHORS = 8;

/** Renders one {@link OwnershipSummary}: bus factor, last touched, author bars. */
@Component({
  selector: 'app-ownership-summary',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (summary().attributedLines === 0) {
      <p class="text-xs text-zinc-600">
        @if (summary().pendingLines > 0) {
          Annotating…
        } @else if (summary().olderLines > 0) {
          All lines predate the loaded history — load older commits to attribute them.
        } @else {
          Nothing to attribute.
        }
      </p>
    } @else {
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
        <span
          class="rounded-full border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 text-zinc-300"
          [title]="
            'The fewest authors who together wrote more than half of the ' +
            summary().attributedLines +
            ' attributed lines.'
          "
        >
          Bus factor {{ summary().busFactor }}
        </span>
        @if (summary().latest; as latest) {
          <span title="Most recent commit among these lines">
            Last touched {{ date(latest.authoredAt) }} by {{ latest.authorName }}
          </span>
        }
      </div>

      <ul class="mt-2 space-y-1.5">
        @for (author of topAuthors(); track author.name) {
          <li>
            <div class="flex items-baseline gap-2 text-xs">
              <span class="min-w-0 flex-1 truncate text-zinc-200" [title]="author.name">{{
                author.name
              }}</span>
              <span class="shrink-0 tabular-nums text-zinc-500">{{ percent(author.share) }}%</span>
            </div>
            <div class="mt-0.5 flex items-center gap-2">
              <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
                <div
                  class="h-full rounded-full bg-indigo-500"
                  [style.width.%]="percent(author.share)"
                ></div>
              </div>
              <span class="w-24 shrink-0 text-right text-[10px] text-zinc-600">
                {{ author.lines }} {{ author.lines === 1 ? 'line' : 'lines' }}
              </span>
            </div>
          </li>
        }
      </ul>
      @if (extraAuthors() > 0) {
        <p class="mt-1.5 text-[11px] text-zinc-600">+{{ extraAuthors() }} more</p>
      }
      @if (summary().olderLines > 0 || summary().pendingLines > 0) {
        <p class="mt-2 text-[11px] text-zinc-600">
          {{ summary().attributedLines }} of {{ summary().totalLines }} lines attributed
          @if (summary().pendingLines > 0) {
            · {{ summary().pendingLines }} still computing
          }
          @if (summary().olderLines > 0) {
            · {{ summary().olderLines }} older than loaded history
          }
        </p>
      }
    }
  `,
})
export class OwnershipSummaryView {
  readonly summary = input.required<OwnershipSummary>();

  protected readonly topAuthors = computed(() => this.summary().authors.slice(0, MAX_AUTHORS));
  protected readonly extraAuthors = computed(() =>
    Math.max(0, this.summary().authors.length - MAX_AUTHORS),
  );

  protected percent(share: number): number {
    return Math.round(share * 100);
  }

  protected date(iso: string): string {
    return `${shortDate(iso)} (${relativeTime(iso)})`;
  }
}

/**
 * "Owners" side panel: who wrote the selected file (folded from its blame),
 * and — on demand — who owns its folder. The folder scan blames many files,
 * so it is opt-in and capped.
 */
@Component({
  selector: 'app-ownership-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OwnershipSummaryView],
  host: { class: 'flex h-full flex-col bg-zinc-950' },
  template: `
    <header
      class="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3"
    >
      <svg
        class="size-3.5 text-indigo-300/80"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11" />
      </svg>
      <span class="text-xs font-semibold tracking-wide text-zinc-200 uppercase">Ownership</span>
      <span class="flex-1"></span>
      <button
        type="button"
        class="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
        (click)="closed.emit()"
        aria-label="Close ownership panel"
      >
        <svg
          class="size-4"
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

    <div class="slim-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3">
      @if (path()) {
        <section>
          <h3 class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">This file</h3>
          <p class="mt-0.5 mb-2 truncate font-mono text-xs text-zinc-400" [title]="path()">
            {{ baseName() }}
          </p>
          @if (fileSummary(); as s) {
            <app-ownership-summary [summary]="s" />
            @if (fileRisk(); as r) {
              @if (r.attributedLines > 0) {
                <p class="mt-2 text-[11px] leading-4 text-zinc-500">
                  <span class="text-zinc-300">{{ percent(r.staleShare) }}% stale</span> —
                  age-weighted across {{ r.attributedLines }} attributed lines (older edits weigh
                  more).
                </p>
                @if (r.owner; as o) {
                  <p class="mt-0.5 text-[11px] text-zinc-600">
                    Mostly {{ o.name }}, last here {{ rel(o.lastAuthoredAt) }}.
                  </p>
                }
              }
            }
          } @else if (blameUnavailable(); as reason) {
            <p class="text-xs text-zinc-600">{{ reason }}</p>
          } @else {
            <p class="text-xs text-zinc-600">Annotating this file…</p>
          }
        </section>

        <section class="mt-5 border-t border-zinc-800/70 pt-4">
          <h3 class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
            Folder · {{ folderLabel() }}
          </h3>
          @if (currentFolder(); as fo) {
            <p class="mt-1 mb-2 text-[11px] text-zinc-600">
              @if (fo.status === 'computing') {
                Scanning {{ fo.filesScanned }}/{{ fo.filesTotal }} files…
              } @else {
                <span
                  class="cursor-help underline decoration-dotted underline-offset-2"
                  [title]="tooltip(fo.files)"
                  >{{ fo.filesScanned }}
                  {{ fo.filesScanned === 1 ? 'file' : 'files' }} scanned</span
                >{{ fo.capped ? ' · largest ' + fo.filesTotal + ' of ' + fo.matchedTotal : '' }}
              }
            </p>
            @if (fo.message) {
              <p class="mb-2 text-xs text-zinc-600">{{ fo.message }}</p>
            }
            <div class="mb-2 flex gap-3 text-[11px]">
              <button
                type="button"
                class="border-b pb-0.5 transition"
                [class]="
                  folderTab() === 'authors'
                    ? 'border-indigo-400 text-zinc-200'
                    : 'border-transparent text-zinc-500 hover:text-zinc-300'
                "
                (click)="folderTab.set('authors')"
              >
                Authors
              </button>
              <button
                type="button"
                class="border-b pb-0.5 transition"
                [class]="
                  folderTab() === 'risk'
                    ? 'border-indigo-400 text-zinc-200'
                    : 'border-transparent text-zinc-500 hover:text-zinc-300'
                "
                (click)="folderTab.set('risk')"
              >
                Risk
              </button>
            </div>
            @if (folderTab() === 'authors') {
              <app-ownership-summary [summary]="fo.summary" />
            } @else {
              <p class="mb-2 text-[11px] leading-4 text-zinc-500">
                Files most at risk of knowledge loss — those whose code has gone stale (old,
                rarely-touched lines whose original authors have likely moved on).
              </p>
              @if (folderRisk().length) {
                <ul class="space-y-1.5">
                  @for (f of folderRisk(); track f.path) {
                    <li>
                      <div class="flex items-baseline gap-2 text-xs">
                        <span
                          class="min-w-0 flex-1 truncate font-mono text-zinc-200"
                          [title]="f.path"
                          >{{ base(f.path) }}</span
                        >
                        <span class="shrink-0 tabular-nums text-zinc-500"
                          >{{ percent(f.staleShare) }}%</span
                        >
                      </div>
                      <div class="mt-0.5 flex items-center gap-2">
                        <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
                          <div
                            class="h-full rounded-full bg-indigo-500"
                            [style.width.%]="riskBar(f)"
                          ></div>
                        </div>
                        <span
                          class="w-24 shrink-0 truncate text-right text-[10px] text-zinc-600"
                          [title]="f.owner ? 'mostly ' + f.owner.name : ''"
                        >
                          @if (f.owner) {
                            {{ f.owner.name }}
                          } @else {
                            {{ round(f.staleLines) }} lines
                          }
                        </span>
                      </div>
                    </li>
                  }
                </ul>
                <p class="mt-2 text-[10px] leading-4 text-zinc-600">
                  Ranked by staleness × √lines — each line ages on a ~2-year half-life (older edits
                  weigh more), averaged per file, then scaled by √(line count) so size counts
                  without dominating.
                </p>
              } @else {
                <p class="text-xs text-zinc-600">No files at risk — the code here is recent.</p>
              }
            }
            @if (fo.capped || !fo.fromCache) {
              <div class="mt-3 flex flex-wrap items-center gap-2">
                @if (fo.capped) {
                  <button
                    type="button"
                    class="rounded border border-indigo-400/30 bg-indigo-500/10 px-2 py-1 text-[11px] font-medium text-indigo-200 transition hover:bg-indigo-500/20"
                    (click)="scanAll.emit()"
                  >
                    Scan all {{ fo.matchedTotal }} files
                  </button>
                }
                <!-- A chart folded from cache has nothing to clear; only an
                     explicit scan offers a Clear (which also cancels it). -->
                @if (!fo.fromCache) {
                  <button
                    type="button"
                    class="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
                    (click)="clearFolder.emit()"
                  >
                    Clear
                  </button>
                }
              </div>
            }
          } @else {
            <p class="mt-1 mb-2 text-[11px] leading-4 text-zinc-600">
              Blame the files under this folder (subfolders included, up to {{ folderCap() }},
              largest first) and combine them — one history walk per file, so it can use a lot of
              API requests.
            </p>
            <div class="flex flex-wrap items-center gap-2">
              <button
                type="button"
                class="rounded-lg border border-indigo-400/30 bg-indigo-500/10 px-3 py-1.5 text-xs font-medium text-indigo-200 transition hover:bg-indigo-500/20"
                (click)="scanFolder.emit()"
              >
                Scan this folder
              </button>
              @if (folderFileCount() > folderCap()) {
                <button
                  type="button"
                  class="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
                  (click)="scanAll.emit()"
                >
                  Scan all {{ folderFileCount() }}
                </button>
              }
            </div>
          }
        </section>
      } @else {
        <p class="text-xs text-zinc-600">Select a file to see who owns it.</p>
      }
    </div>
  `,
})
export class OwnershipPanel {
  /** Selected file path; null when nothing is selected. */
  readonly path = input<string | null>(null);
  readonly fileSummary = input<OwnershipSummary | null>(null);
  /** Knowledge-loss risk of the selected file (orphaned lines), or null. */
  readonly fileRisk = input<FileRisk | null>(null);
  /** Reason the file's authorship can't be shown (binary/too-large/error), or null. */
  readonly blameUnavailable = input<string | null>(null);
  /** Parent folder of the selected file ('' for the repository root). */
  readonly folderPath = input<string>('');
  readonly folder = input<FolderOwnershipState | null>(null);
  readonly folderCap = input<number>(30);
  /** Total files under the folder (so the prompt can offer an uncapped scan). */
  readonly folderFileCount = input<number>(0);

  readonly closed = output<void>();
  readonly scanFolder = output<void>();
  /** Request an uncapped scan of every file under the folder. */
  readonly scanAll = output<void>();
  readonly clearFolder = output<void>();

  /** Authors vs. Risk view of the scanned folder. */
  protected readonly folderTab = signal<'authors' | 'risk'>('authors');

  /** Newline-joined file list for the "files scanned" tooltip. */
  protected tooltip(files: readonly string[]): string {
    return files.join('\n');
  }

  protected percent(share: number): number {
    return Math.round(share * 100);
  }

  protected round(value: number): number {
    return Math.round(value);
  }

  protected rel(iso: string): string {
    return relativeTime(iso);
  }

  protected base(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(slash + 1) : path;
  }

  /** Width (%) of a file's risk bar, relative to the riskiest in the folder. */
  protected riskBar(file: FileRisk): number {
    const max = this.folderRiskMax();
    if (max <= 0 || file.riskScore <= 0) return 0;
    return Math.max(3, (file.riskScore / max) * 100);
  }

  protected readonly baseName = computed(() => {
    const path = this.path() ?? '';
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(slash + 1) : path;
  });

  protected readonly folderLabel = computed(() => {
    const folder = this.folderPath();
    if (!folder) return 'repository root';
    const slash = folder.lastIndexOf('/');
    return slash >= 0 ? folder.slice(slash + 1) : folder;
  });

  /** The folder result, but only when it is for the file's current folder. */
  protected readonly currentFolder = computed(() => {
    const folder = this.folder();
    return folder && folder.path === this.folderPath() ? folder : null;
  });

  /** Files of the current folder ranked by risk (empty until scanned). */
  protected readonly folderRisk = computed<readonly FileRisk[]>(
    () => this.currentFolder()?.riskFiles ?? [],
  );
  /** Largest risk score in the folder, for scaling the risk bars. */
  protected readonly folderRiskMax = computed(() =>
    this.folderRisk().reduce((max, file) => Math.max(max, file.riskScore), 0),
  );
}
