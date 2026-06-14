import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CoChangeState } from '../../core/store/repo-store';
import { computeCoChange } from '../../core/util/co-change';
import { computeHotspots } from '../../core/util/hotspots';
import { InsightsView } from './insights-view';

const COMMITS = [
  { sha: 'c1', files: ['src/auth.ts', 'src/session.ts'] },
  { sha: 'c2', files: ['src/auth.ts', 'src/session.ts'] },
  { sha: 'c3', files: ['src/auth.ts', 'README.md'] },
];
const HOTSPOTS = computeHotspots(
  [
    { authorName: 'Ada', authoredAt: '2026-06-13T00:00:00Z', files: ['src/hot.ts'] },
    { authorName: 'Ada', authoredAt: '2026-06-12T00:00:00Z', files: ['src/hot.ts'] },
  ],
  new Map([['src/hot.ts', 500]]),
  { now: Date.parse('2026-06-14T00:00:00Z') },
);
const OVERVIEW: CoChangeState = {
  status: 'ready',
  scanned: 3,
  target: 75,
  result: computeCoChange(COMMITS),
  hotspots: HOTSPOTS,
};
const FOCUSED: CoChangeState = {
  status: 'ready',
  focus: 'src/auth.ts',
  scanned: 3,
  target: 400,
  result: computeCoChange(COMMITS, { minSupport: 1 }),
  hotspots: [],
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

  function clickContaining(label: string): void {
    const el = Array.from(
      fixture.nativeElement.querySelectorAll('button') as HTMLButtonElement[],
    ).find((b) => (b.textContent ?? '').includes(label));
    el!.click();
  }

  async function setState(state: CoChangeState): Promise<void> {
    fixture.componentRef.setInput('state', state);
    await fixture.whenStable();
  }

  it('prompts to analyze when there is no result yet, and emits on click', () => {
    expect(text()).toContain('Repository insights');
    button('Analyze recent history')!.click();
    expect(analyzed).toBe(1);
  });

  it('reports progress against the state target, and surfaces a ready message', async () => {
    await setState({
      status: 'computing',
      scanned: 10,
      target: 50,
      result: computeCoChange([]),
      hotspots: [],
    });
    expect(text()).toContain('10/50');

    await setState({
      status: 'ready',
      scanned: 0,
      target: 75,
      result: computeCoChange([]),
      hotspots: [],
      message: 'No commit history found.',
    });
    expect(text()).toContain('No commit history found.');
    expect(text()).not.toContain('No file activity');
  });

  it('shows hotspots (treemap + list) by default and opens a file on click', async () => {
    await setState(OVERVIEW);
    expect(fixture.nativeElement.querySelector('svg rect')).not.toBeNull();
    expect(text()).toContain('hot.ts');

    clickContaining('hot.ts'); // the list row
    expect(opened).toEqual(['src/hot.ts']);
  });

  it('switches to coupling and focuses a file when a pair is clicked', async () => {
    await setState(OVERVIEW);
    button('Coupling')!.click();
    await fixture.whenStable();

    expect(text()).toContain('auth.ts');
    expect(text()).toContain('session.ts');

    button('auth.ts')!.click();
    expect(focused).toEqual(['src/auth.ts']);
  });

  it('shows a focused file’s full coupling; drills on click and opens from the banner', async () => {
    await setState(FOCUSED);

    const t = text();
    expect(t).toContain('Changes with');
    expect(t).toContain('session.ts');
    expect(t).toContain('README.md'); // minSupport 1 in focus mode

    button('session.ts')!.click();
    expect(focused).toEqual(['src/session.ts']);

    button('Open file')!.click();
    expect(opened).toEqual(['src/auth.ts']);
  });
});
