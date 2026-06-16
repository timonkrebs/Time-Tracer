import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CoChangeState } from '../../core/store/repo-store';
import { computeCoChange } from '../../core/util/co-change';
import { computeHotspots } from '../../core/util/hotspots';
import { EMPTY_TEAM_GRAPH, computeTeamGraph } from '../../core/util/team-graph';
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
  hotspots: HOTSPOTS,
  teamGraph: EMPTY_TEAM_GRAPH,
};
// A hotspot whose file is absent from the current tree → size 0. squarify
// drops non-positive weights, so without the clamp it would list but not tile.
const ZERO_SIZED: CoChangeState = {
  status: 'ready',
  target: 75,
  scanned: 2,
  result: computeCoChange([]),
  hotspots: computeHotspots(
    [
      { authorName: 'Ada', authoredAt: '2026-06-13T00:00:00Z', files: ['gone.ts'] },
      { authorName: 'Ada', authoredAt: '2026-06-12T00:00:00Z', files: ['gone.ts'] },
    ],
    new Map(), // gone.ts isn't in the tree → size 0
    { now: Date.parse('2026-06-14T00:00:00Z') },
  ),
  teamGraph: EMPTY_TEAM_GRAPH,
};
// A single file's full-history coupling — driven through the `focus` input.
const FOCUSED: CoChangeState = {
  status: 'ready',
  focus: 'src/auth.ts',
  scanned: 3,
  target: 400,
  result: computeCoChange(COMMITS, { minSupport: 1 }),
  hotspots: [],
  teamGraph: EMPTY_TEAM_GRAPH,
};
const COLLIDING: CoChangeState = {
  status: 'ready',
  scanned: 2,
  target: 75,
  result: computeCoChange([
    { sha: 'd1', files: ['src/a/index.ts', 'src/b/index.ts'] },
    { sha: 'd2', files: ['src/a/index.ts', 'src/b/index.ts'] },
  ]),
  hotspots: [],
  teamGraph: EMPTY_TEAM_GRAPH,
};
// A 4-file clique → forms a cluster (≥ 3 files) for the graph.
const CLUSTERED: CoChangeState = {
  status: 'ready',
  scanned: 2,
  target: 75,
  result: computeCoChange([
    { sha: 'k1', files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'] },
    { sha: 'k2', files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'] },
  ]),
  hotspots: [],
  teamGraph: EMPTY_TEAM_GRAPH,
};
// Ada & Bo share auth.ts/session.ts (a connected pair); Cy only ever touches
// db.ts alone — a silo. Drives the Team tab.
const TEAM: CoChangeState = {
  status: 'ready',
  scanned: 5,
  target: 75,
  result: computeCoChange([]),
  hotspots: [],
  teamGraph: computeTeamGraph([
    { authorName: 'Ada', files: ['src/auth.ts', 'src/session.ts'] },
    { authorName: 'Bo', files: ['src/auth.ts', 'src/session.ts'] },
    { authorName: 'Ada', files: ['src/auth.ts'] },
    { authorName: 'Cy', files: ['src/db.ts'] },
    { authorName: 'Cy', files: ['src/db.ts'] },
  ]),
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
      hotspots: [],
      teamGraph: EMPTY_TEAM_GRAPH,
    });
    expect(text()).toContain('10/50');

    await setState({
      status: 'ready',
      scanned: 0,
      target: 75,
      result: computeCoChange([]),
      hotspots: [],
      teamGraph: EMPTY_TEAM_GRAPH,
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

  it('graphs only linked developers and lists the silos beneath', async () => {
    await setState(TEAM);
    button('Team')!.click();
    await fixture.whenStable();

    // Only the two linked developers (Ada, Bo) get a node; Cy works alone, so it
    // is left out of the graph and listed underneath instead.
    expect(fixture.nativeElement.querySelectorAll('svg circle').length).toBe(2);
    const titles = Array.from(
      fixture.nativeElement.querySelectorAll('svg title') as SVGTitleElement[],
    ).map((el) => el.textContent ?? '');
    expect(titles.some((title) => title.includes('Cy'))).toBe(false);

    const t = text();
    expect(t).toContain('3 developers');
    expect(t).toContain('1 ties');
    expect(t).toContain('Most connected');
    expect(t).toContain('Working in isolation');
    expect(t).toContain('Cy'); // listed beneath the graph, not drawn in it
  });

  it('selects a developer to reveal their collaborators, and clears again', async () => {
    await setState(TEAM);
    button('Team')!.click();
    await fixture.whenStable();

    const node = Array.from(fixture.nativeElement.querySelectorAll('g') as SVGGElement[]).find(
      (g) => (g.querySelector('title')?.textContent ?? '').includes('Ada'),
    );
    node!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await fixture.whenStable();

    // The collaborator panel lists Bo with the shared-file count…
    expect(text()).toContain('Collaborators');
    expect(text()).toContain('2 shared');
    expect(text()).not.toContain('Most connected');

    button('Clear')!.click();
    await fixture.whenStable();
    expect(text()).toContain('Most connected');
    expect(text()).not.toContain('Collaborators');
  });

  it('prompts to analyze on the Team tab when only a file filter is active', async () => {
    await setFocus(FOCUSED); // a focus but no repo-wide overview
    button('Team')!.click();
    await fixture.whenStable();

    expect(text()).toContain('Analyze the history to map the team.');
    button('Analyze recent history')!.click();
    expect(analyzed).toBe(1);
  });

  it('exposes a temporal-weight slider that updates its readout', async () => {
    await setState(TEAM);
    button('Team')!.click();
    await fixture.whenStable();

    // Defaults to a balanced blend, shown as a percentage.
    expect(text()).toContain('50%');

    drag('Temporal weighting', 100);
    await fixture.whenStable();
    expect(text()).toContain('100%');
  });

  it('keeps ties visible even when the slider fades them out', async () => {
    await setState(TEAM);
    button('Team')!.click();
    await fixture.whenStable();
    // The Ada–Bo tie is drawn at the default blend…
    expect(fixture.nativeElement.querySelector('svg line')).not.toBeNull();

    // …and TEAM has no commit dates, so fully weighted toward recent the tie is
    // faded to 0% — but it is de-emphasised, not removed.
    drag('Temporal weighting', 100);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('svg line')).not.toBeNull();
    expect(fixture.nativeElement.querySelectorAll('svg circle').length).toBe(2);
  });
});
