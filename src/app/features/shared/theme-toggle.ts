import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { ThemeService } from '../../core/theme/theme';

/**
 * A single button that cycles the colour theme auto → light → dark. The icon
 * reflects the current *preference* (a half-disc for auto, sun for light, moon
 * for dark); the tooltip/aria-label says what a click will switch to.
 */
@Component({
  selector: 'app-theme-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="shrink-0 rounded p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
      (click)="theme.cycle()"
      [attr.aria-label]="label()"
      [title]="label()"
    >
      @switch (theme.preference()) {
        @case ('light') {
          <svg
            class="size-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="4" />
            <path
              d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"
            />
          </svg>
        }
        @case ('dark') {
          <svg
            class="size-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
          </svg>
        }
        @default {
          <svg
            class="size-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
          </svg>
        }
      }
    </button>
  `,
})
export class ThemeToggle {
  protected readonly theme = inject(ThemeService);

  protected readonly label = computed(() => {
    switch (this.theme.preference()) {
      case 'light':
        return 'Theme: light — switch to dark';
      case 'dark':
        return 'Theme: dark — switch to auto';
      default:
        return 'Theme: auto — switch to light';
    }
  });
}
