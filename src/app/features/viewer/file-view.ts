import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { RepoWebLinks } from '../../core/git/git-provider';
import { FileState } from '../../core/models';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Right pane of the viewer: renders the selected file (text with a line
 * number gutter — the future home of blame annotations), or the matching
 * empty/loading/binary/too-large/error state.
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
        @if (textInfo(); as info) {
          <div class="slim-scrollbar min-h-0 flex-1 overflow-auto">
            <div class="flex min-w-max font-mono text-[13px] leading-6">
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

  /** Emits the path when the user wants to retry a failed fetch. */
  readonly retry = output<string>();
  readonly historyToggle = output<void>();

  protected readonly skeletonWidths = [62, 84, 45, 91, 73, 38, 80, 55, 67, 49, 88, 30];

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

  protected formattedSize(bytes: number): string {
    return formatBytes(bytes);
  }
}
