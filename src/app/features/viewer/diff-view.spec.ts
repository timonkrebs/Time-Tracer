import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CommitInfo } from '../../core/models';
import { DiffState } from '../../core/store/repo-store';
import { FileDiff } from '../../core/util/diff';
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

function panes(fixture: ComponentFixture<DiffView>): HTMLElement[] {
  return Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.overflow-auto'),
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
});
