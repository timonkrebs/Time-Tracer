import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { RepoWebLinks } from '../../core/git/git-provider';
import { FileState } from '../../core/models';
import { BlameOwner, BlameState } from '../../core/store/repo-store';
import { relativeTime, shortSha } from '../../core/util/relative-time';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Annotation text colour by commit age — oldest first, newest last. */
const AGE_CLASSES = [
  'text-zinc-600',
  'text-zinc-500',
  'text-zinc-400',
  'text-indigo-300/90',
  'text-amber-300/90',
];

interface BlameRow {
  readonly lineNo: number;
  readonly text: string;
  readonly sha: string | null;
  readonly label: string;
  readonly title: string;
  readonly colorClass: string;
  readonly showLabel: boolean;
  readonly pendingOwner: boolean;
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
        @if (blameRows(); as rows) {
          <div class="slim-scrollbar min-h-0 flex-1 overflow-auto">
            <div class="min-w-max font-mono text-[13px] leading-6">
              @for (row of rows; track row.lineNo) {
                <div class="flex hover:bg-white/[0.02]">
                  <span class="w-52 shrink-0 truncate pl-4 text-xs leading-6 select-none">
                    @if (row.sha) {
                      @if (row.showLabel) {
                        <button
                          type="button"
                          class="max-w-full cursor-pointer truncate align-top underline-offset-2 transition hover:underline"
                          [class]="row.colorClass"
                          [title]="row.title"
                          (click)="blameSelect.emit(row.sha)"
                        >
                          {{ row.label }}
                        </button>
                      }
                    } @else if (row.pendingOwner) {
                      <span class="animate-pulse text-zinc-700">·</span>
                    } @else if (row.showLabel) {
                      <span class="text-zinc-700" [title]="row.title">{{ row.label }}</span>
                    }
                  </span>
                  <span
                    class="w-10 shrink-0 border-l border-zinc-800/60 pr-2 text-right text-zinc-600 select-none"
                    aria-hidden="true"
                    >{{ row.lineNo }}</span
                  >
                  <span class="pr-10 pl-3 whitespace-pre text-zinc-200 [tab-size:4]">{{
                    row.text
                  }}</span>
                </div>
              }
            </div>
          </div>
        } @else if (textInfo(); as info) {
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
  /** Renders per-line blame annotations in the gutter. */
  readonly blameActive = input(false);
  readonly blame = input<BlameState | null>(null);

  /** Emits the path when the user wants to retry a failed fetch. */
  readonly retry = output<string>();
  readonly historyToggle = output<void>();
  readonly blameToggle = output<void>();
  /** Emits the sha of a clicked line annotation. */
  readonly blameSelect = output<string>();

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
    const blame = this.blame();
    const owners: readonly BlameOwner[] =
      blame && (blame.status === 'computing' || blame.status === 'ready') ? blame.lines : [];

    // Rank unique commit times so annotation colour reflects relative age.
    const uniqueTimes = [
      ...new Set(
        owners
          .filter((o): o is Exclude<BlameOwner, 'older' | null> => !!o && o !== 'older')
          .map((o) => Date.parse(o.authoredAt) || 0),
      ),
    ].sort((a, b) => a - b);
    const colorFor = (time: number): string => {
      if (uniqueTimes.length <= 1) return AGE_CLASSES[AGE_CLASSES.length - 1];
      const rank = uniqueTimes.indexOf(time) / (uniqueTimes.length - 1);
      return AGE_CLASSES[Math.round(rank * (AGE_CLASSES.length - 1))];
    };

    const lines = info.text.split('\n');
    return lines.map((text, index) => {
      const owner = owners[index] ?? null;
      const previous = index > 0 ? (owners[index - 1] ?? null) : undefined;
      const sameAsPrevious =
        owner !== null &&
        previous !== undefined &&
        previous !== null &&
        (owner === 'older'
          ? previous === 'older'
          : previous !== 'older' && owner.sha === previous.sha);

      if (owner === null) {
        return {
          lineNo: index + 1,
          text,
          sha: null,
          label: '',
          title: '',
          colorClass: '',
          showLabel: false,
          pendingOwner: true,
        };
      }
      if (owner === 'older') {
        return {
          lineNo: index + 1,
          text,
          sha: null,
          label: '· · ·',
          title: 'Older than the loaded history pages.',
          colorClass: '',
          showLabel: !sameAsPrevious,
          pendingOwner: false,
        };
      }
      return {
        lineNo: index + 1,
        text,
        sha: owner.sha,
        label: `${owner.authorName} · ${relativeTime(owner.authoredAt)}`,
        title: `${owner.summary}\n${shortSha(owner.sha)} · ${owner.authorName} · ${relativeTime(owner.authoredAt)}`,
        colorClass: colorFor(Date.parse(owner.authoredAt) || 0),
        showLabel: !sameAsPrevious,
        pendingOwner: false,
      };
    });
  });

  protected formattedSize(bytes: number): string {
    return formatBytes(bytes);
  }
}
