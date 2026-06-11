import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { DiffState } from '../../core/store/repo-store';
import { shortSha } from '../../core/util/relative-time';

interface DiffRow {
  readonly type: 'hunk' | 'add' | 'remove' | 'ctx';
  readonly oldNo: string;
  readonly newNo: string;
  readonly marker: string;
  readonly text: string;
}

/**
 * Unified diff of what one commit changed in the selected file: dual line
 * number gutter, +/− markers, hunk headers. This rendering is the visual
 * primitive the blame view will reuse for "what did this commit introduce".
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
      } @else {
        <div class="slim-scrollbar min-h-0 flex-1 overflow-auto">
          <div class="min-w-max font-mono text-[13px] leading-6">
            @for (row of rows(); track $index) {
              @if (row.type === 'hunk') {
                <div class="flex bg-sky-500/10 text-sky-300/80">
                  <span class="w-24 shrink-0 select-none"></span>
                  <span class="px-4 whitespace-pre">{{ row.text }}</span>
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

  readonly retry = output<void>();

  protected readonly skeletonWidths = [70, 45, 88, 60, 35, 78, 52];

  protected readonly rows = computed<DiffRow[]>(() => {
    const s = this.state();
    if (!s || s.status !== 'ready') return [];
    const rows: DiffRow[] = [];
    for (const hunk of s.diff.hunks) {
      rows.push({ type: 'hunk', oldNo: '', newNo: '', marker: '', text: hunk.header });
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

  protected abbrev(sha: string): string {
    return shortSha(sha);
  }
}
