import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CoChangeState } from '../../core/store/repo-store';
import { computeCoChange } from '../../core/util/co-change';
import { InsightsView } from './insights-view';

const COMMITS = [
  { sha: 'c1', files: ['src/auth.ts', 'src/session.ts'] },
  { sha: 'c2', files: ['src/auth.ts', 'src/session.ts'] },
  { sha: 'c3', files: ['src/auth.ts', 'README.md'] },
];
const OVERVIEW: CoChangeState = {
  status: 'ready',
  scanned: 3,
  target: 75,
  result: computeCoChange(COMMITS),
};
const FOCUSED: CoChangeState = {
  status: 'ready',
  focus: 'src/auth.ts',
  scanned: 3,
  target: 400,
  result: computeCoChange(COMMITS, { minSupport: 1 }),
};

describe('InsightsView', () => {
  let fixture: ComponentFixture<InsightsView>;
  let analyzed: number;
  let focused: string[];
  let opened: string[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InsightsView],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(InsightsView);
    analyzed = 0;
    focused = [];
    opened = [];
    fixture.componentInstance.analyze.subscribe(() => analyzed++);
    fixture.componentInstance.focusFile.subscribe((p) => focused.push(p));
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

  it('reports progress against the state target, and surfaces a ready message', async () => {
    fixture.componentRef.setInput('state', {
      status: 'computing',
      scanned: 10,
      target: 50,
      result: computeCoChange([]),
    } satisfies CoChangeState);
    await fixture.whenStable();
    expect(text()).toContain('Walking commits… 10/50');

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

  it('lists repo-wide pairs and focuses a file when clicked', async () => {
    fixture.componentRef.setInput('state', OVERVIEW);
    await fixture.whenStable();
    expect(text()).toContain('auth.ts');
    expect(text()).toContain('session.ts');
    expect(text()).not.toContain('README.md'); // support 1 < default minSupport

    button('auth.ts')!.click();
    expect(focused).toEqual(['src/auth.ts']);
  });

  it('shows a focused file’s full coupling; drills on click and opens from the banner', async () => {
    fixture.componentRef.setInput('state', FOCUSED);
    await fixture.whenStable();

    const t = text();
    expect(t).toContain('Changes with');
    expect(t).toContain('session.ts');
    expect(t).toContain('README.md'); // shown here (minSupport 1 for a focused file)

    button('session.ts')!.click();
    expect(focused).toEqual(['src/session.ts']); // drill

    button('Open file')!.click();
    expect(opened).toEqual(['src/auth.ts']);
  });
});
