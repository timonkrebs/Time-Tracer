import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  signal,
} from '@angular/core';

import { copyText } from '../../core/util/clipboard';

/**
 * A button that copies `value` to the clipboard and briefly confirms it.
 * Styling is left to the caller via `buttonClass` so it can blend into any
 * toolbar.
 */
@Component({
  selector: 'app-copy-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      [class]="buttonClass()"
      [title]="title()"
      [disabled]="disabled()"
      (click)="copy()"
    >
      {{ copied() ? copiedLabel() : label() }}
    </button>
  `,
})
export class CopyButton {
  readonly value = input.required<string>();
  readonly label = input('Copy');
  readonly copiedLabel = input('Copied!');
  readonly title = input('');
  readonly buttonClass = input('');
  readonly disabled = input(false);

  protected readonly copied = signal(false);
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clear());
  }

  protected async copy(): Promise<void> {
    if (this.disabled()) return;
    if (!(await copyText(this.value()))) return;
    this.copied.set(true);
    this.clear();
    this.timer = setTimeout(() => this.copied.set(false), 1500);
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
