import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CoChangeState } from '../../core/store/repo-store';
import { computeCoChange } from '../../core/util/co-change';
import { InsightsView } from './insights-view';

const RESULT = computeCoChange([
  { sha: 'c1', files: ['src/auth.ts', 'src/session.ts'] },
  { sha: 'c2', files: ['src/auth.ts', 'src/session.ts'] },
  { sha: 'c3', files: ['src/auth.ts', 'README.md'] },
]);
const READY: CoChangeState = { status: 'ready', scanned: 3, target: 75, result: RESULT };

describe('InsightsView', () => {
  let fixture: ComponentFixture<InsightsView>;
  let analyzed: number;
  let opened: string[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InsightsView],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(InsightsView);
    analyzed = 0;
    opened = [];
    fixture.componentInstance.analyze.subscribe(() => analyzed++);
    fixture.componentInstance.openFile.subscribe((p) => opened.push(p));
    await fixture.whenStable();
  });

  function text(): string {
    return (fixture.nativeElement.textContent ?? '').replace(/\s+/g, ' ');
  }

  function button(label: string): HTMLButtonElement | undefined {
    return Array.from(fixture.nativeElement.querySelectorAll('button') as HTMLButtonElement[]).find(
      (b) => b.textContent?.trim() === label,
    );
  }

  it('prompts to analyze when there is no result yet, and emits on click', () => {
    expect(text()).toContain('Find files that change together');
    button('Analyze recent history')!.click();
    expect(analyzed).toBe(1);
  });

  it('reports progress while computing, against the state target', async () => {
    fixture.componentRef.setInput('state', {
      status: 'computing',
      scanned: 10,
      target: 50,
      result: computeCoChange([]),
    } satisfies CoChangeState);
    await fixture.whenStable();
    expect(text()).toContain('Walking commits… 10/50');
  });

  it('surfaces a ready status message instead of the empty fallback', async () => {
    fixture.componentRef.setInput('state', {
      status: 'ready',
      scanned: 0,
      target: 75,
      result: computeCoChange([]),
      message: 'No commit history found.',
    } satisfies CoChangeState);
    await fixture.whenStable();
    expect(text()).toContain('No commit history found.');
    expect(text()).not.toContain('No files changed together');
  });

  it('lists coupled pairs and opens a file when clicked', async () => {
    fixture.componentRef.setInput('state', READY);
    await fixture.whenStable();

    const t = text();
    expect(t).toContain('auth.ts');
    expect(t).toContain('session.ts');
    expect(t).toContain('2×'); // changed together in 2 commits
    // README.md coupled only once (< minSupport), so it is not shown.
    expect(t).not.toContain('README.md');

    button('auth.ts')!.click();
    expect(opened).toEqual(['src/auth.ts']);
  });
});
