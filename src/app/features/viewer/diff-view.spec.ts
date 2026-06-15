import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CommitInfo } from '../../core/models';
import { DiffState } from '../../core/store/repo-store';
import { FileDiff } from '../../core/util/diff';
import { LineRange } from '../../core/util/line-range';
import { DiffView } from './diff-view';

const COMMIT: CommitInfo = {
  sha: 'a'.repeat(40),
  message: 'change things',
  summary: 'change things',
  authorName: 'Ada',
  authorEmail: null,
  authoredAt: '2026-01-01T00:00:00Z',
  htmlUrl: '',
  parentShas: ['b'.repeat(40)],
};

/** A ready diff with one hunk: a (very long) context line, a remove and an add. */
function readyState(): DiffState {
  const longLine = 'const wide = ' + 'x'.repeat(400) + ';';
  const diff: FileDiff = {
    added: 1,
    removed: 1,
    oldLineCount: 2,
    newLineCount: 2,
    identical: false,
    hunks: [
      {
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 2,
        header: '@@ -1,2 +1,2 @@',
        ops: [
          { kind: 'equal', text: longLine, oldLine: 1, newLine: 1 },
          { kind: 'remove', text: 'gone', oldLine: 2 },
          { kind: 'add', text: 'fresh', newLine: 2 },
        ],
      },
    ],
  };
  return {
    status: 'ready',
    diff,
    commit: COMMIT,
    baseSha: 'b'.repeat(40),
    basePath: 'f.ts',
    headPath: 'f.ts',
  };
}

/** A ready diff whose only change is a removal between two context lines. */
function removalState(): DiffState {
  const diff: FileDiff = {
    added: 0,
    removed: 1,
    oldLineCount: 3,
    newLineCount: 2,
    identical: false,
    hunks: [
      {
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 2,
        header: '@@ -1,3 +1,2 @@',
        ops: [
          { kind: 'equal', text: 'keep one', oldLine: 1, newLine: 1 },
          { kind: 'remove', text: 'removed line', oldLine: 2 },
          { kind: 'equal', text: 'keep two', oldLine: 3, newLine: 2 },
        ],
      },
    ],
  };
  return {
    status: 'ready',
    diff,
    commit: COMMIT,
    baseSha: 'b'.repeat(40),
    basePath: 'f.ts',
    headPath: 'f.ts',
  };
}

function panes(fixture: ComponentFixture<DiffView>): HTMLElement[] {
  return Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.overflow-auto'),
  );
}

function traceButtonsIn(pane: HTMLElement): number {
  return Array.from(pane.querySelectorAll('button')).filter(
    (b) => (b.textContent ?? '').trim() === 'Trace',
  ).length;
}

function traceButton(pane: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(pane.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => (b.textContent ?? '').trim() === 'Trace',
  );
}

describe('DiffView split scrolling', () => {
  let fixture: ComponentFixture<DiffView>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DiffView],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    fixture = TestBed.createComponent(DiffView);
    fixture.componentRef.setInput('state', readyState());
    fixture.componentRef.setInput('path', 'f.ts');
    fixture.componentRef.setInput('splitMode', true);
    fixture.componentRef.setInput('blameActive', true);
    await fixture.whenStable();
  });

  it('renders two horizontally scrollable panes for the side-by-side view', () => {
    const [left, right] = panes(fixture);
    // Two independent scrollers, one per side.
    expect(left).toBeTruthy();
    expect(right).toBeTruthy();
    expect(left.classList.contains('hide-vertical-scrollbar')).toBe(true);
    // Each pane grows to its widest line (min-w-max) so long lines scroll
    // sideways instead of being clipped.
    expect(left.querySelector('.min-w-max')).not.toBeNull();
    expect(right.querySelector('.min-w-max')).not.toBeNull();
    // The code is no longer clipped: no overflow-hidden cells remain.
    expect((fixture.nativeElement as HTMLElement).querySelector('.overflow-hidden')).toBeNull();
  });

  it('mirrors a left-side scroll onto the right side (both axes)', () => {
    const [left, right] = panes(fixture);
    left.scrollTop = 48;
    left.scrollLeft = 120;
    left.dispatchEvent(new Event('scroll'));

    expect(right.scrollTop).toBe(48);
    expect(right.scrollLeft).toBe(120);
  });

  it('mirrors a right-side scroll onto the left side (both axes)', () => {
    const [left, right] = panes(fixture);
    right.scrollTop = 72;
    right.scrollLeft = 200;
    right.dispatchEvent(new Event('scroll'));

    expect(left.scrollTop).toBe(72);
    expect(left.scrollLeft).toBe(200);
  });

  it('keeps Trace on the After side, never the Before side', () => {
    // The default fixture is a replace run (remove paired with add).
    const [before, after] = panes(fixture);
    expect(traceButtonsIn(before)).toBe(0);
    expect(traceButtonsIn(after)).toBeGreaterThan(0);
  });

  it('surfaces a pure-removal block its Trace on the After side', async () => {
    fixture.componentRef.setInput('state', removalState());
    await fixture.whenStable();

    const [before, after] = panes(fixture);
    // The removed line shows on the Before side, but its Trace stays on the After side.
    expect(traceButtonsIn(before)).toBe(0);
    expect(traceButtonsIn(after)).toBe(1);
  });

  it('emits a deletion trace with the old-side range for a pure removal', async () => {
    fixture.componentRef.setInput('state', removalState());
    await fixture.whenStable();

    let normal: LineRange | undefined;
    let deletion: LineRange | undefined;
    fixture.componentInstance.trace.subscribe((r) => (normal = r));
    fixture.componentInstance.traceDeletion.subscribe((r) => (deletion = r));

    traceButton(panes(fixture)[1])!.click();

    // Tracing a deleted line follows the old-side lines it removed, not the gap.
    expect(normal).toBeUndefined();
    expect(deletion).toEqual({ start: 2, end: 2 });
  });

  it('emits a normal new-side trace for a changed (non-deletion) block', () => {
    // The default fixture is a replace run: the new line exists, so it traces normally.
    let normal: LineRange | undefined;
    let deletion: LineRange | undefined;
    fixture.componentInstance.trace.subscribe((r) => (normal = r));
    fixture.componentInstance.traceDeletion.subscribe((r) => (deletion = r));

    traceButton(panes(fixture)[1])!.click();

    expect(deletion).toBeUndefined();
    expect(normal).toEqual({ start: 2, end: 2 });
  });
});
