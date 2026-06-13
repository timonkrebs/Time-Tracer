import { ChangeDetectionStrategy, Component } from '@angular/core';

import { HEAT_STYLES } from './heat';

/**
 * Colour scale for the file-tree hotspot badges: a cold→hot gradient that
 * explains what the per-file change-heat colours mean. Shown beneath the tree
 * once at least one file has a metric.
 */
@Component({
  selector: 'app-heat-legend',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="flex items-center gap-1.5"
      title="Files are badged by how often they change, weighted toward recent changes — cold (rarely / long ago) to hot (often / recently)."
    >
      <span class="shrink-0 text-[10px] tracking-wide text-zinc-500 uppercase">Change heat</span>
      <span class="text-[10px] text-zinc-600">cold</span>
      <span class="flex h-2 flex-1 overflow-hidden rounded-sm" aria-hidden="true">
        @for (style of styles; track $index) {
          <span class="flex-1" [class]="style.swatch"></span>
        }
      </span>
      <span class="text-[10px] text-zinc-600">hot</span>
    </div>
  `,
})
export class HeatLegend {
  protected readonly styles = HEAT_STYLES;
}
