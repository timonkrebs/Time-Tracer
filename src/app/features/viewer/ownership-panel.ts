import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { FolderOwnershipState } from '../../core/store/repo-store';
import { OwnershipSummary } from '../../core/util/ownership';
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
                {{ fo.filesScanned }} {{ fo.filesScanned === 1 ? 'file' : 'files' }} scanned{{
                  fo.capped ? ' (capped at ' + fo.filesTotal + ')' : ''
                }}
              }
            </p>
            @if (fo.message) {
              <p class="mb-2 text-xs text-zinc-600">{{ fo.message }}</p>
            }
            <app-ownership-summary [summary]="fo.summary" />
            <button
              type="button"
              class="mt-3 rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
              (click)="clearFolder.emit()"
            >
              Clear
            </button>
          } @else {
            <p class="mt-1 mb-2 text-[11px] leading-4 text-zinc-600">
              Blame this folder's files (up to {{ folderCap() }}, largest first) and combine them —
              one history walk per file, so it can use a lot of API requests.
            </p>
            <button
              type="button"
              class="rounded-lg border border-indigo-400/30 bg-indigo-500/10 px-3 py-1.5 text-xs font-medium text-indigo-200 transition hover:bg-indigo-500/20"
              (click)="scanFolder.emit()"
            >
              Scan this folder
            </button>
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
  /** Parent folder of the selected file ('' for the repository root). */
  readonly folderPath = input<string>('');
  readonly folder = input<FolderOwnershipState | null>(null);
  readonly folderCap = input<number>(30);

  readonly closed = output<void>();
  readonly scanFolder = output<void>();
  readonly clearFolder = output<void>();

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
}
