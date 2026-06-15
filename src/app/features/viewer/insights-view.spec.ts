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
  target: 75,
  scanned: 3,
  result: computeCoChange(COMMITS),
  commits: COMMITS,
  hotspots: HOTSPOTS,
};
// A hotspot whose file is absent from the current tree → size 0. squarify
// drops non-positive weights, so without the clamp it would list but not tile.
const ZERO_SIZED: CoChangeState = {
  status: 'ready',
  target: 75,
  scanned: 2,
  result: computeCoChange([]),
  commits: [],
  hotspots: computeHotspots(
    [
      { authorName: 'Ada', authoredAt: '2026-06-13T00:00:00Z', files: ['gone.ts'] },
      { authorName: 'Ada', authoredAt: '2026-06-12T00:00:00Z', files: ['gone.ts'] },
    ],
    new Map(), // gone.ts isn't in the tree → size 0
    { now: Date.parse('2026-06-14T00:00:00Z') },
  ),
};
// A single file's full-history coupling — driven through the `focus` input.
const FOCUSED: CoChangeState = {
  status: 'ready',
  focus: 'src/auth.ts',
  scanned: 3,
  target: 400,
  result: computeCoChange(COMMITS, { minSupport: 1 }),
  commits: COMMITS,
  hotspots: [],
};
const COLLIDING_COMMITS = [
  { sha: 'd1', files: ['src/a/index.ts', 'src/b/index.ts'] },
  { sha: 'd2', files: ['src/a/index.ts', 'src/b/index.ts'] },
];
const COLLIDING: CoChangeState = {
  status: 'ready',
  scanned: 2,
  target: 75,
  result: computeCoChange(COLLIDING_COMMITS),
  commits: COLLIDING_COMMITS,
  hotspots: [],
};
// A 4-file clique → forms a cluster (≥ 3 files) for the graph.
const CLUSTERED_COMMITS = [
  { sha: 'k1', files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'] },
  { sha: 'k2', files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'] },
];
const CLUSTERED: CoChangeState = {
  status: 'ready',
  scanned: 2,
  target: 75,
  result: computeCoChange(CLUSTERED_COMMITS),
  commits: CLUSTERED_COMMITS,
  hotspots: [],
};
// Two folders that always change together → module coupling at depth 2.
const MODULES_COMMITS = [
  { sha: 'p1', files: ['src/auth/login.ts', 'src/ui/button.ts'] },
  { sha: 'p2', files: ['src/auth/login.ts', 'src/ui/button.ts'] },
];
const MODULES: CoChangeState = {
  status: 'ready',
  scanned: 2,
  target: 75,
  result: computeCoChange(MODULES_COMMITS),
  commits: MODULES_COMMITS,
  hotspots: [],
};
// Three folders forming a clique → a module cluster (≥ 3) for the graph.
const MODULE_CLUSTER_COMMITS = [
  { sha: 'q1', files: ['api/a.ts', 'web/b.ts', 'db/c.ts'] },
  { sha: 'q2', files: ['api/a.ts', 'web/b.ts', 'db/c.ts'] },
];
const MODULE_CLUSTER: CoChangeState = {
  status: 'ready',
  scanned: 2,
  target: 75,
  result: computeCoChange(MODULE_CLUSTER_COMMITS),
  commits: MODULE_CLUSTER_COMMITS,
  hotspots: [],
};
// Two folders that always change together, but via *different* files each time
// → no file pair clears minSupport, yet module coupling exists.
const MODULE_ONLY_COMMITS = [
  { sha: 'r1', files: ['auth/a.ts', 'ui/x.ts'] },
  { sha: 'r2', files: ['auth/b.ts', 'ui/y.ts'] },
];
const MODULE_ONLY: CoChangeState = {
  status: 'ready',
  scanned: 2,
  target: 75,
  result: computeCoChange(MODULE_ONLY_COMMITS),
  commits: MODULE_ONLY_COMMITS,
  hotspots: [],
};

describe('InsightsView', () => {
  let fixture: ComponentFixture<InsightsView>;
  let analyzed: number;
  let loadedAll: number;
  let focused: string[];
  let clearedFocus: number;
  let opened: string[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InsightsView],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(InsightsView);
    analyzed = 0;
    loadedAll = 0;
    focused = [];
    clearedFocus = 0;
    opened = [];
    fixture.componentInstance.analyze.subscribe(() => analyzed++);
    fixture.componentInstance.loadAll.subscribe(() => loadedAll++);
    fixture.componentInstance.focusFile.subscribe((p) => focused.push(p));
    fixture.componentInstance.clearFocus.subscribe(() => clearedFocus++);
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

  /** Moves a range slider (found by aria-label) to a value. */
  function drag(ariaLabel: string, value: number): void {
    const input = fixture.nativeElement.querySelector(
      `input[aria-label="${ariaLabel}"]`,
    ) as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event('input'));
  }

  async function setState(state: CoChangeState): Promise<void> {
    fixture.componentRef.setInput('state', state);
    await fixture.whenStable();
  }

  async function setFocus(focus: CoChangeState): Promise<void> {
    fixture.componentRef.setInput('focus', focus);
    await fixture.whenStable();
  }

  it('prompts when there is no result yet, and emits from both buttons', () => {
    expect(text()).toContain('Find files that change together');
    button('Analyze recent history')!.click();
    expect(analyzed).toBe(1);
    button('Load all commits')!.click();
    expect(loadedAll).toBe(1);
  });

  it('reports progress against the state target, and surfaces a ready message', async () => {
    await setState({
      status: 'computing',
      scanned: 10,
      target: 50,
      result: computeCoChange([]),
      commits: [],
      hotspots: [],
    });
    expect(text()).toContain('10/50');

    await setState({
      status: 'ready',
      scanned: 0,
      target: 75,
      result: computeCoChange([]),
      commits: [],
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

  it('still tiles a zero-size hotspot (absent from the tree), not just lists it', async () => {
    await setState(ZERO_SIZED);
    // size 0 would be dropped by squarify; clamped, it stays a tile so the
    // treemap and the ranked list stay consistent.
    expect(fixture.nativeElement.querySelector('svg rect')).not.toBeNull();
    expect(text()).toContain('gone.ts');
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

  it('draws a coupling cluster graph and focuses a node on click', async () => {
    await setState(CLUSTERED);
    button('Coupling')!.click();
    await fixture.whenStable();

    // The cluster is drawn as an SVG node-link graph (edges + nodes).
    expect(fixture.nativeElement.querySelector('svg line')).not.toBeNull();
    expect(fixture.nativeElement.querySelectorAll('svg circle').length).toBeGreaterThan(0);

    const node = Array.from(fixture.nativeElement.querySelectorAll('g') as SVGGElement[]).find(
      (g) => (g.querySelector('title')?.textContent ?? '').includes('src/b.ts'),
    );
    node!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(focused).toContain('src/b.ts');
  });

  it('hides clusters outside the size range slider', async () => {
    await setState(CLUSTERED); // a 4-file cluster, inside the default band (3–20)
    button('Coupling')!.click();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('svg circle')).not.toBeNull();

    // Lowering the max handle below 4 puts the cluster above the band…
    drag('Maximum cluster size', 3);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('svg circle')).toBeNull();

    // …and raising the min handle above 4 puts it below the band.
    drag('Maximum cluster size', 8);
    drag('Minimum cluster size', 5);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('svg circle')).toBeNull();
  });

  it('shows full paths when basenames collide', async () => {
    await setState(COLLIDING);
    button('Coupling')!.click();
    await fixture.whenStable();

    // Two index.ts files → labels fall back to the full path to disambiguate.
    expect(text()).toContain('src/a/index.ts');
    expect(text()).toContain('src/b/index.ts');
  });

  it('rolls coupling up to modules and re-buckets by depth', async () => {
    await setState(MODULES);
    button('Coupling')!.click();
    await fixture.whenStable();
    button('Modules')!.click();
    await fixture.whenStable();

    // Depth 2 (default): src/auth ↔ src/ui change together.
    expect(text()).toContain('src/auth');
    expect(text()).toContain('src/ui');

    // Depth 1 collapses both into "src", so there is no cross-module coupling.
    drag('Module depth', 1);
    await fixture.whenStable();
    expect(text()).toContain('No modules change together');
  });

  it('draws a module cluster graph with weighted edges', async () => {
    await setState(MODULE_CLUSTER);
    button('Coupling')!.click();
    await fixture.whenStable();
    button('Modules')!.click();
    await fixture.whenStable();

    // Three folders forming a clique → a node-link graph (edges + nodes).
    expect(fixture.nativeElement.querySelector('svg line')).not.toBeNull();
    expect(fixture.nativeElement.querySelectorAll('svg circle').length).toBeGreaterThanOrEqual(3);

    // Each edge is labelled with the coupling strength (these always change
    // together → 100%).
    const labels = Array.from(
      fixture.nativeElement.querySelectorAll('svg text') as SVGTextElement[],
    ).map((t) => t.textContent?.trim());
    expect(labels).toContain('100%');
  });

  it('reaches module coupling even when no file pair survives minSupport', async () => {
    await setState(MODULE_ONLY);
    button('Coupling')!.click();
    await fixture.whenStable();

    // No file pairs cleared minSupport, but the granularity toggle is still here…
    expect(text()).toContain('No files changed together');
    button('Modules')!.click();
    await fixture.whenStable();

    // …and the module roll-up surfaces the auth ↔ ui coupling.
    expect(text()).toContain('auth');
    expect(text()).toContain('ui');
  });

  it('shows a live folder-depth example that tracks the slider', async () => {
    await setState(MODULES); // files under src/auth and src/ui
    button('Coupling')!.click();
    await fixture.whenStable();
    button('Modules')!.click();
    await fixture.whenStable();

    // Depth 2 groups two levels deep, e.g. src/auth.
    expect(text()).toContain('e.g.');
    expect(text()).toContain('src/auth');
    // Depth 1 groups one level deep, so the example collapses to just "src".
    drag('Module depth', 1);
    await fixture.whenStable();
    expect(text()).toContain('e.g. src');
    expect(text()).not.toContain('src/auth');
  });

  it('keeps both tabs available once anything is analysed', async () => {
    // Even with only a file filter (no repo-wide overview), the tabs show.
    await setFocus(FOCUSED);
    expect(button('Hotspots')).toBeTruthy();
    expect(button('Coupling')).toBeTruthy();
  });

  it('filters coupling to one file, drills on click, and opens/clears from the banner', async () => {
    await setFocus(FOCUSED); // the focus input auto-selects the Coupling tab

    const t = text();
    expect(t).toContain('Coupling for');
    expect(t).toContain('session.ts');
    expect(t).toContain('README.md'); // minSupport 1 in focus mode

    button('session.ts')!.click();
    expect(focused).toEqual(['src/session.ts']);

    button('Open file')!.click();
    expect(opened).toEqual(['src/auth.ts']);

    button('Clear filter')!.click();
    expect(clearedFocus).toBe(1);
  });

  it('shows the file filter alongside the overview, and keeps the overview when cleared', async () => {
    await setState(OVERVIEW);
    await setFocus(FOCUSED);

    // The filter takes over the coupling tab…
    expect(text()).toContain('Coupling for');

    // …and the repo-wide hotspots are still there underneath.
    button('Hotspots')!.click();
    await fixture.whenStable();
    expect(text()).toContain('hot.ts');
  });
});
