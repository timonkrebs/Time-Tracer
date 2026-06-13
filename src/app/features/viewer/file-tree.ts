import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

import { TreeNode } from '../../core/models';
import { FileMetric, heatLevel } from '../../core/util/hotspots';
import { relativeTime } from '../../core/util/relative-time';
import { HEAT_STYLES } from './heat';
import { HeatPopup } from './heat-popup';

/** Maps a file name to a Tailwind text colour class for its icon. */
function fileIconColor(name: string): string {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
      return 'text-sky-400';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'text-yellow-400';
    case 'json':
      return 'text-amber-300';
    case 'md':
    case 'mdx':
      return 'text-emerald-400';
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return 'text-pink-400';
    case 'html':
    case 'htm':
      return 'text-orange-400';
    case 'yml':
    case 'yaml':
    case 'toml':
      return 'text-lime-400';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
    case 'ico':
      return 'text-purple-400';
    default:
      return 'text-zinc-500';
  }
}

/**
 * One level of the repository tree; renders itself recursively for expanded
 * directories. Expansion/selection state lives in the store and is passed
 * down so every level stays in sync.
 */
@Component({
  selector: 'app-file-tree',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FileTree, HeatPopup],
  template: `
    @for (node of nodes(); track node.path) {
      @if (node.kind === 'dir') {
        <button
          type="button"
          class="flex w-full items-center gap-1.5 rounded px-2 py-[3px] text-left text-[13px] text-zinc-300 transition-colors hover:bg-white/5"
          [style.padding-left.px]="8 + depth() * 14"
          (click)="dirToggle.emit(node.path)"
        >
          <svg
            class="size-3 shrink-0 text-zinc-500 transition-transform"
            [class.rotate-90]="expanded().has(node.path)"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
          <svg
            class="size-4 shrink-0 text-indigo-300/80"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            @if (expanded().has(node.path)) {
              <path
                d="M19.5 21a3 3 0 0 0 3-3v-4.5a3 3 0 0 0-3-3h-15a3 3 0 0 0-3 3V18a3 3 0 0 0 3 3h15ZM1.5 10.146V6a3 3 0 0 1 3-3h5.379a2.25 2.25 0 0 1 1.59.659l2.122 2.121c.14.141.331.22.53.22H19.5a3 3 0 0 1 3 3v1.146A4.483 4.483 0 0 0 19.5 9h-15a4.483 4.483 0 0 0-3 1.146Z"
              />
            } @else {
              <path
                d="M19.5 21a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3h-5.379a.75.75 0 0 1-.53-.22L11.47 3.66A2.25 2.25 0 0 0 9.879 3H4.5a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h15Z"
              />
            }
          </svg>
          <span class="truncate">{{ node.name }}</span>
        </button>
        @if (expanded().has(node.path)) {
          <app-file-tree
            [nodes]="node.children ?? []"
            [depth]="depth() + 1"
            [selectedPath]="selectedPath()"
            [expanded]="expanded()"
            [metrics]="metrics()"
            (fileSelect)="fileSelect.emit($event)"
            (dirToggle)="dirToggle.emit($event)"
          />
        }
      } @else if (node.kind === 'file') {
        <button
          type="button"
          class="flex w-full items-center gap-1.5 rounded px-2 py-[3px] text-left text-[13px] transition-colors"
          [class]="
            selectedPath() === node.path
              ? 'bg-indigo-500/20 text-zinc-50'
              : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
          "
          [style.padding-left.px]="8 + depth() * 14 + 18"
          (click)="fileSelect.emit(node.path)"
        >
          <svg
            class="size-4 shrink-0"
            [class]="iconColor(node.name)"
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
          <span class="min-w-0 truncate">{{ node.name }}</span>
          @if (metricFor(node.path); as m) {
            <span
              class="heat-badge ml-auto shrink-0 cursor-default rounded px-1 text-[10px] leading-[15px] font-medium tabular-nums"
              [class]="heatClass(m.score)"
              [attr.aria-label]="metricLabel(m)"
              (mouseenter)="onBadgeEnter($event, m)"
              (mouseleave)="onBadgeLeave()"
              >{{ scoreLabel(m.score) }}</span
            >
          }
        </button>
      } @else {
        <div
          class="flex w-full items-center gap-1.5 px-2 py-[3px] text-[13px] text-zinc-600"
          [style.padding-left.px]="8 + depth() * 14 + 18"
          title="Git submodule — not browsable here"
        >
          <svg
            class="size-4 shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <path d="M12 8v8M8 12h8" />
          </svg>
          <span class="truncate">{{ node.name }}</span>
          <span class="ml-auto shrink-0 text-[10px] tracking-wide uppercase">submodule</span>
        </div>
      }
    }
    @if (hovered(); as h) {
      <div
        class="pointer-events-none fixed z-50"
        [style.right.px]="h.right"
        [style.top.px]="h.top"
        [style.transform]="h.flip ? 'translateY(-100%)' : null"
      >
        <app-heat-popup [metric]="h.metric" />
      </div>
    }
  `,
})
export class FileTree {
  readonly nodes = input.required<readonly TreeNode[]>();
  readonly depth = input(0);
  readonly selectedPath = input<string | null>(null);
  readonly expanded = input.required<ReadonlySet<string>>();
  /** Recency-weighted change metrics by path; files in it get a hotspot badge. */
  readonly metrics = input<ReadonlyMap<string, FileMetric>>(new Map());

  readonly fileSelect = output<string>();
  readonly dirToggle = output<string>();

  /** The badge being hovered and where to anchor its popup, if any. */
  protected readonly hovered = signal<{
    readonly metric: FileMetric;
    readonly right: number;
    readonly top: number;
    readonly flip: boolean;
  } | null>(null);

  protected iconColor(name: string): string {
    return fileIconColor(name);
  }

  /**
   * Opens the hotspot popup anchored under the hovered badge, right-aligned to
   * it and flipped above when there is little room below the viewport edge.
   */
  protected onBadgeEnter(event: MouseEvent, metric: FileMetric): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const flip = rect.bottom > window.innerHeight - 200;
    this.hovered.set({
      metric,
      right: Math.max(8, window.innerWidth - rect.right),
      top: flip ? rect.top - 6 : rect.bottom + 6,
      flip,
    });
  }

  protected onBadgeLeave(): void {
    this.hovered.set(null);
  }

  /** The metric for a path, or null until its history shows a change. */
  protected metricFor(path: string): FileMetric | null {
    const metric = this.metrics().get(path);
    return metric && metric.revisions > 0 ? metric : null;
  }

  /** Compact badge label: one decimal under 10, rounded above. */
  protected scoreLabel(score: number): string {
    return score >= 10 ? String(Math.round(score)) : score.toFixed(1);
  }

  protected heatClass(score: number): string {
    return HEAT_STYLES[heatLevel(score)].badge;
  }

  /** Accessible summary of the badge (the popup shows the visual detail). */
  protected metricLabel(m: FileMetric): string {
    const parts: string[] = [
      `${m.partial ? '≥ ' : ''}${m.revisions} change${m.revisions === 1 ? '' : 's'}`,
      `recency-weighted ${m.score.toFixed(1)}`,
    ];
    if (m.lastChange) parts.push(`last changed ${relativeTime(m.lastChange)}`);
    if (m.authors > 0) parts.push(`${m.authors} author${m.authors === 1 ? '' : 's'}`);
    return parts.join(' · ');
  }
}
