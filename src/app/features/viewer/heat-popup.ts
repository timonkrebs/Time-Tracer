import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { FileMetric, HEAT_THRESHOLDS, heatLevel } from '../../core/util/hotspots';
import { relativeTime, shortDate } from '../../core/util/relative-time';
import { HEAT_STYLES } from './heat';

/**
 * Hover card for a file's hotspot metric: its band and recency-weighted
 * score, the newest and oldest change behind it, and an explanation of how
 * the colour is derived (with the heat scale and the band's score range).
 */
@Component({
  selector: 'app-heat-popup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="w-64 rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-xs text-zinc-300 shadow-xl"
      role="tooltip"
    >
      <div class="flex items-center gap-2">
        <span class="size-2.5 shrink-0 rounded-sm" [class]="style().swatch"></span>
        <span class="font-medium text-zinc-100">{{ style().label }}</span>
        <span class="ml-auto tabular-nums text-zinc-400"
          >score {{ metric().score.toFixed(1) }}</span
        >
      </div>
      <p class="mt-1 text-zinc-500">{{ summary() }}</p>

      <dl class="mt-2 space-y-1">
        @if (metric().lastChange; as last) {
          <div class="flex justify-between gap-2">
            <dt class="shrink-0 text-zinc-500">Newest change</dt>
            <dd class="truncate text-right text-zinc-300">{{ when(last) }}</dd>
          </div>
        }
        @if (metric().firstChange; as first) {
          <div class="flex justify-between gap-2">
            <dt class="shrink-0 text-zinc-500">
              {{ metric().partial ? 'Oldest loaded' : 'Oldest change' }}
            </dt>
            <dd class="truncate text-right text-zinc-300">{{ when(first) }}</dd>
          </div>
        }
      </dl>

      <div class="mt-2 border-t border-zinc-800 pt-2">
        <p class="text-zinc-500">
          Colour shows the recency-weighted change score — each change counts 2<sup>−age/90d</sup>,
          so recent changes weigh more.
        </p>
        <div class="mt-1.5 flex items-center gap-2">
          <span class="flex h-2 flex-1 overflow-hidden rounded-sm" aria-hidden="true">
            @for (s of styles; track $index) {
              <span
                class="flex-1"
                [class]="s.swatch"
                [class.opacity-30]="$index !== level()"
              ></span>
            }
          </span>
          <span class="shrink-0 text-zinc-400">{{ style().label }} {{ range() }}</span>
        </div>
      </div>
    </div>
  `,
})
export class HeatPopup {
  readonly metric = input.required<FileMetric>();

  protected readonly styles = HEAT_STYLES;
  protected readonly level = computed(() => heatLevel(this.metric().score));
  protected readonly style = computed(() => HEAT_STYLES[this.level()]);

  /** `≥ 5 changes · 2 authors`, the partial marker and plurals handled. */
  protected readonly summary = computed(() => {
    const m = this.metric();
    const changes = `${m.partial ? '≥ ' : ''}${m.revisions} change${m.revisions === 1 ? '' : 's'}`;
    return m.authors > 0
      ? `${changes} · ${m.authors} author${m.authors === 1 ? '' : 's'}`
      : changes;
  });

  /** The score range of the file's band, e.g. `4–8`, `< 0.75`, `≥ 8`. */
  protected readonly range = computed(() => {
    const level = this.level();
    if (level === 0) return `< ${HEAT_THRESHOLDS[1]}`;
    if (level === 4) return `≥ ${HEAT_THRESHOLDS[4]}`;
    return `${HEAT_THRESHOLDS[level]}–${HEAT_THRESHOLDS[level + 1]}`;
  });

  protected when(iso: string): string {
    return `${shortDate(iso)} · ${relativeTime(iso)}`;
  }
}
