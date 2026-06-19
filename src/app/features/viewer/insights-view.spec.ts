import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CoChangeState, SurvivalState } from '../../core/store/repo-store';
import { computeCoChange } from '../../core/util/co-change';
import { computeHotspots } from '../../core/util/hotspots';
import { computeKnowledgeRisk } from '../../core/util/knowledge';
import { CohortBucket, LineLifetime, summarizeSurvival } from '../../core/util/survival';
import { EMPTY_TEAM_GRAPH, computeTeamGraph } from '../../core/util/team-graph';
import { InsightsView } from './insights-view';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-06-14T00:00:00Z');
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY_MS).toISOString();
/** An empty knowledge model, for fixtures whose tests don't touch the tab. */
const EMPTY_KNOWLEDGE = computeKnowledgeRisk([], new Map());

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
  knowledge: EMPTY_KNOWLEDGE,
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
  knowledge: EMPTY_KNOWLEDGE,
};
// Three differently-sized hotspots, to exercise the size-filter slider.
const SIZED: CoChangeState = {
  status: 'ready',
  target: 75,
  scanned: 2,
  result: computeCoChange([]),
  hotspots: computeHotspots(
    [
      {
        authorName: 'Ada',
        authoredAt: '2026-06-13T00:00:00Z',
        files: ['src/tiny.ts', 'src/mid.ts', 'src/huge.ts'],
      },
      {
        authorName: 'Ada',
        authoredAt: '2026-06-12T00:00:00Z',
        files: ['src/tiny.ts', 'src/mid.ts', 'src/huge.ts'],
      },
    ],
    new Map([
      ['src/tiny.ts', 100],
      ['src/mid.ts', 3000],
      ['src/huge.ts', 80000],
    ]),
    { now: NOW },
  ),
  teamGraph: EMPTY_TEAM_GRAPH,
  knowledge: EMPTY_KNOWLEDGE,
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
  knowledge: EMPTY_KNOWLEDGE,
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
  knowledge: EMPTY_KNOWLEDGE,
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
  knowledge: EMPTY_KNOWLEDGE,
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
  knowledge: EMPTY_KNOWLEDGE,
};

// Two files: one orphaned (sole author long gone), one freshly co-owned.
const KNOWLEDGE: CoChangeState = {
  status: 'ready',
  scanned: 4,
  target: 75,
  result: computeCoChange([]),
  hotspots: [],
  teamGraph: EMPTY_TEAM_GRAPH,
  knowledge: computeKnowledgeRisk(
    [
      { authorName: 'Gone', authoredAt: iso(220), files: ['src/legacy.ts'] },
      { authorName: 'Gone', authoredAt: iso(240), files: ['src/legacy.ts'] },
      { authorName: 'Ada', authoredAt: iso(2), files: ['src/fresh.ts'] },
      { authorName: 'Linus', authoredAt: iso(4), files: ['src/fresh.ts'] },
    ],
    new Map([
      ['src/legacy.ts', 800],
      ['src/fresh.ts', 400],
    ]),
    { now: NOW, partial: true },
  ),
};

// A lifetime table with survivors (2020 + 2024 cohorts) and two deaths, so the
// Age tab has cohorts, authorship and a Kaplan–Meier curve to draw.
const SURVIVAL_NOW = Date.UTC(2026, 0, 1);
const LIFETIMES: LineLifetime[] = [
  { bornAt: Date.UTC(2020, 0, 1), diedAt: null, author: 'Ada' },
  { bornAt: Date.UTC(2020, 0, 1), diedAt: null, author: 'Ada' },
  { bornAt: Date.UTC(2024, 0, 1), diedAt: null, author: 'Bob' },
  { bornAt: Date.UTC(2019, 0, 1), diedAt: Date.UTC(2021, 0, 1), author: 'Ada' },
  { bornAt: Date.UTC(2019, 0, 1), diedAt: Date.UTC(2025, 0, 1), author: 'Bob' },
];
const SURVIVAL: SurvivalState = {
  status: 'ready',
  scanned: 12,
  total: 12,
  report: summarizeSurvival(LIFETIMES, { now: SURVIVAL_NOW }),
};

describe('InsightsView', () => {
  let fixture: ComponentFixture<InsightsView>;
  let analyzed: number;
  let loadedAll: number;
  let survivalRuns: number;
  let focused: string[];
  let clearedFocus: number;
  let opened: string[];
  let bucketChanges: CohortBucket[];

  beforeEach(async () => {
    // jsdom has no layout, so scrollIntoView logs a "not implemented" error;
    // stub it so selecting a quadrant dot (which scrolls its row into view) is quiet.
    Element.prototype.scrollIntoView = () => {};

    await TestBed.configureTestingModule({
      imports: [InsightsView],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(InsightsView);
    analyzed = 0;
    loadedAll = 0;
    survivalRuns = 0;
    focused = [];
    clearedFocus = 0;
    opened = [];
    bucketChanges = [];
    fixture.componentInstance.cohortBucketChange.subscribe((b) => bucketChanges.push(b));
    fixture.componentInstance.analyze.subscribe(() => analyzed++);
    fixture.componentInstance.loadAll.subscribe(() => loadedAll++);
    fixture.componentInstance.computeSurvival.subscribe(() => survivalRuns++);
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
      knowledge: EMPTY_KNOWLEDGE,
    });
    expect(text()).toContain('10/50');

    await setState({
      status: 'ready',
      scanned: 0,
      target: 75,
      result: computeCoChange([]),
      hotspots: [],
      teamGraph: EMPTY_TEAM_GRAPH,
      knowledge: EMPTY_KNOWLEDGE,
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

  it('filters the hotspot treemap by file size', async () => {
    await setState(SIZED);
    // No limit by default: every file is shown.
    let t = text();
    expect(t).toContain('tiny.ts');
    expect(t).toContain('mid.ts');
    expect(t).toContain('huge.ts');

    // Lowering the max-size handle drops the larger files, keeping the small one.
    drag('Maximum file size', 50);
    await fixture.whenStable();
    t = text();
    expect(t).toContain('tiny.ts');
    expect(t).not.toContain('huge.ts');

    // Dragging it to the bottom filters everything out — a distinct empty state.
    drag('Maximum file size', 0);
    await fixture.whenStable();
    t = text();
    expect(t).not.toContain('tiny.ts');
    expect(t).toContain('No files within the selected size range.');
  });

  it('ignores a stale size filter once the control is hidden', async () => {
    await setState(SIZED);
    drag('Maximum file size', 0); // filter everything out
    await fixture.whenStable();

    // A later result with too few files to filter hides the slider — the stale
    // limit must not keep dropping the lone file with no control to restore it.
    await setState(OVERVIEW);
    expect(fixture.nativeElement.querySelector('input[aria-label="Maximum file size"]')).toBeNull();
    expect(text()).toContain('hot.ts');
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

  it('truncates long cluster-graph node labels with a middle ellipsis', () => {
    const view = fixture.componentInstance as unknown as { nodeLabel(s: string): string };
    // Short labels pass through untouched.
    expect(view.nodeLabel('src/a/index.ts')).toBe('src/a/index.ts');
    // Long ones keep the head and the filename tail so both stay readable,
    // capped so the cluster graph can't push the layout past the viewport.
    expect(view.nodeLabel('compiler/rustc_expand/src/mbe/diagnostics.rs')).toBe(
      'compiler/rus…gnostics.rs',
    );
  });

  it('keeps all three tabs available once anything is analysed', async () => {
    // Even with only a file filter (no repo-wide overview), the tabs show.
    await setFocus(FOCUSED);
    expect(button('Hotspots')).toBeTruthy();
    expect(button('Coupling')).toBeTruthy();
    expect(button('Knowledge')).toBeTruthy();
  });

  it('maps knowledge risk (quadrant + list), flags the departed expert, and opens a file', async () => {
    await setState(KNOWLEDGE);
    button('Knowledge')!.click();
    await fixture.whenStable();

    // The risk quadrant plots each file as a bubble.
    expect(fixture.nativeElement.querySelector('svg circle')).not.toBeNull();
    const t = text();
    expect(t).toContain('legacy.ts');
    expect(t).toContain('Gone'); // the departed primary expert, named
    expect(t).toContain('gone'); // the "gone <when>" badge
    expect(t).toContain('complete turnover picture'); // partial-walk hint
    expect(t).toContain('orphaned'); // the ranked-list column header
    expect(t).toContain('authored knowledge has gone quiet'); // departed-knowledge headline
    expect(t).toContain('known to only one person'); // bus-factor callout (legacy.ts)
    expect(t).toContain('Knowledge holders'); // the contributor breakdown

    // The row now selects/cross-highlights; the ↗ icon is the explicit "open file".
    const open = fixture.nativeElement.querySelector(
      'button[aria-label="Open src/legacy.ts"]',
    ) as HTMLButtonElement;
    open.click();
    expect(opened).toContain('src/legacy.ts');
  });

  it('cross-highlights the list row and the quadrant dot, both directions', async () => {
    await setState(KNOWLEDGE);
    button('Knowledge')!.click();
    await fixture.whenStable();

    const selectRow = (name: string): HTMLButtonElement =>
      Array.from(
        fixture.nativeElement.querySelectorAll('button[aria-pressed]') as HTMLButtonElement[],
      ).find((b) => (b.textContent ?? '').includes(name))!;
    const selectionRing = (): Element | null =>
      fixture.nativeElement.querySelector('svg circle[stroke="#818cf8"]');

    // Nothing selected: no ring on the chart, row not pressed.
    expect(selectionRing()).toBeNull();
    expect(selectRow('legacy.ts').getAttribute('aria-pressed')).toBe('false');

    // List → chart: clicking the row highlights its dot (and opens nothing).
    selectRow('legacy.ts').click();
    await fixture.whenStable();
    expect(selectRow('legacy.ts').getAttribute('aria-pressed')).toBe('true');
    expect(selectionRing()).not.toBeNull();
    expect(opened).toEqual([]);

    // Clicking the same row again clears the selection.
    selectRow('legacy.ts').click();
    await fixture.whenStable();
    expect(selectionRing()).toBeNull();

    // Chart → list: clicking the dot marks the matching row selected.
    const dot = fixture.nativeElement.querySelector('svg g.cursor-pointer') as SVGGElement;
    dot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await fixture.whenStable();
    expect(selectRow('legacy.ts').getAttribute('aria-pressed')).toBe('true');
    expect(opened).toEqual([]);
  });

  it('reveals a hover tooltip with the file name and metrics over a quadrant bubble', async () => {
    await setState(KNOWLEDGE);
    button('Knowledge')!.click();
    await fixture.whenStable();

    // Nothing tooltip-specific until a bubble is hovered.
    expect(text()).not.toContain('bus factor');

    // The riskiest file (legacy.ts, 800 B) sorts first, so it's the first bubble.
    const bubble = fixture.nativeElement.querySelector('svg g.cursor-pointer') as SVGGElement;
    bubble.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await fixture.whenStable();

    const t = text();
    expect(t).toContain('bus factor'); // the expert / bus-factor line
    expect(t).toContain('800 B'); // the size, shown only in the tooltip

    bubble.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    await fixture.whenStable();
    expect(text()).not.toContain('bus factor');
  });

  it('prompts to analyze on the knowledge tab when only a focus filter is set', async () => {
    await setFocus(FOCUSED); // focus auto-selects coupling…
    button('Knowledge')!.click(); // …switch to knowledge, which has no repo-wide state
    await fixture.whenStable();

    expect(text()).toContain('Analyze the history to map knowledge risk');
    button('Analyze recent history')!.click();
    expect(analyzed).toBe(1);
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

  describe('Age tab (code survival)', () => {
    async function setSurvival(survival: SurvivalState): Promise<void> {
      fixture.componentRef.setInput('survivalAvailable', true);
      fixture.componentRef.setInput('survival', survival);
      await fixture.whenStable();
    }

    it('offers a survival analysis from the cold start and emits it (local repos)', async () => {
      fixture.componentRef.setInput('survivalAvailable', true);
      await fixture.whenStable();
      expect(text()).toContain('code survival');
      button('Analyze code age & survival')!.click();
      expect(survivalRuns).toBe(1);
    });

    it('hides the Age option for non-local repositories', async () => {
      // Cold start, hosted repo: no survival entry…
      expect(button('Analyze code age & survival')).toBeUndefined();
      // …and once coupling is analysed, the tab bar shows no Age tab.
      fixture.componentRef.setInput('state', OVERVIEW);
      await fixture.whenStable();
      expect(button('Age')).toBeUndefined();
      expect(button('Hotspots')).toBeDefined();
    });

    it('charts the cohort stack, authorship and Kaplan–Meier curve when ready', async () => {
      await setSurvival(SURVIVAL);
      button('Age')!.click();
      await fixture.whenStable();

      expect(text()).toContain('Survival curve');
      expect(text()).toContain('Kaplan–Meier');
      expect(text()).toContain('Code half-life');
      expect(text()).toContain('surviving code by author');
      // The fixture's history is < 10 years, so 10-year survival is not extrapolated.
      expect(text()).toContain('unobserved');
      // Birth-year cohorts and authors of the live code show up in the legends.
      expect(text()).toContain('2020');
      expect(text()).toContain('Ada');
      // The three charts each render at least one SVG.
      expect(fixture.nativeElement.querySelectorAll('svg').length).toBeGreaterThanOrEqual(3);
    });

    it('emits a cohort-granularity change from the slider and reflects the bound bucket', async () => {
      await setSurvival(SURVIVAL);
      button('Age')!.click();
      await fixture.whenStable();

      const slider = fixture.nativeElement.querySelector(
        'input[aria-label^="Cohort granularity"]',
      ) as HTMLInputElement;
      expect(slider).toBeTruthy();
      // Default granularity is 'year' → the rightmost stop.
      expect(slider.value).toBe('2');
      expect(text()).toContain('Surviving lines by year added');

      // Dragging to the middle stop emits 'month'.
      slider.value = '1';
      slider.dispatchEvent(new Event('input'));
      expect(bucketChanges).toEqual(['month']);

      // The title and slider position follow the bound granularity input.
      fixture.componentRef.setInput('cohortBucket', 'week');
      await fixture.whenStable();
      expect(text()).toContain('Surviving lines by week added');
      expect(slider.value).toBe('0');
    });

    it('redraws the cohort chart when the report is re-bucketed', async () => {
      await setSurvival(SURVIVAL); // year-bucketed cohorts
      button('Age')!.click();
      await fixture.whenStable();
      // Year legend shows bare years, no month suffix.
      expect(text()).toContain('2024');
      expect(text()).not.toContain('2024-01');

      // The slider emits 'month'; the store responds by pushing a re-bucketed
      // report plus the new bound bucket — exactly what viewer-page wires up.
      const slider = fixture.nativeElement.querySelector(
        'input[aria-label^="Cohort granularity"]',
      ) as HTMLInputElement;
      slider.value = '1';
      slider.dispatchEvent(new Event('input'));
      expect(bucketChanges).toEqual(['month']);

      fixture.componentRef.setInput('cohortBucket', 'month');
      fixture.componentRef.setInput('survival', {
        ...SURVIVAL,
        report: summarizeSurvival(LIFETIMES, { now: SURVIVAL_NOW, bucket: 'month' }),
      });
      await fixture.whenStable();
      // The chart and legend now reflect monthly cohorts.
      expect(text()).toContain('Surviving lines by month added');
      expect(text()).toContain('2024-01');
    });

    it('shows progress while the history is still being walked', async () => {
      await setSurvival({
        status: 'computing',
        scanned: 40,
        total: 100,
        report: summarizeSurvival([], { now: SURVIVAL_NOW }),
      });
      button('Age')!.click();
      await fixture.whenStable();
      expect(text()).toContain('Walking the full history');
    });
  });

  describe('Bus factor', () => {
    it('lists contributors and simulates a departure', async () => {
      await setState(KNOWLEDGE);
      button('Bus factor')!.click();
      await fixture.whenStable();

      // Contributors from the knowledge model, and the already-orphaned baseline
      // (legacy.ts has only an inactive author).
      expect(text()).toContain('Ada');
      expect(text()).toContain('Linus');
      expect(text()).toContain('1/2 owned files are already orphaned');

      // fresh.ts rests on Ada + Linus together; remove both and it is orphaned.
      clickContaining('Ada');
      clickContaining('Linus');
      await fixture.whenStable();
      expect(text()).toContain('1 more file would be orphaned');
      expect(text()).toContain('fresh.ts');

      // The tab offers CSV/JSON export.
      expect(button('CSV')).toBeDefined();
      expect(button('JSON')).toBeDefined();
    });
  });

  describe('Git Wrapped', () => {
    const PUNCH: CoChangeState = {
      status: 'ready',
      scanned: 3,
      target: 75,
      result: computeCoChange([]),
      hotspots: [],
      teamGraph: EMPTY_TEAM_GRAPH,
      knowledge: EMPTY_KNOWLEDGE,
      commitTimes: ['2024-01-03T14:00:00Z', '2024-01-03T14:20:00Z', '2024-01-01T09:00:00Z'],
    };

    it('keeps the punch card (with its grid and toggles) under the Wrapped tab', async () => {
      await setState(PUNCH);
      button('Git Wrapped')!.click();
      await fixture.whenStable();
      expect(text()).toContain('3 commits');
      expect(text()).toContain('Wed 14:00'); // busiest slot
      expect(text()).toContain('weekends');
      expect(text()).toContain('Mon');
      expect(text()).toContain('Sun');

      // Toggle to the year × weekday view.
      button('Year × weekday')!.click();
      await fixture.whenStable();
      expect(text()).toContain('2024');

      // …and the month × weekday (seasonal) view.
      button('Month × weekday')!.click();
      await fixture.whenStable();
      expect(text()).toContain('Jan');
      expect(text()).toContain('Dec');
    });

    it('shows year-in-review cards with a PNG export', async () => {
      await setState(PUNCH);
      button('Git Wrapped')!.click();
      await fixture.whenStable();
      expect(text()).toContain('Git Wrapped');
      expect(text()).toContain('Busiest day');
      expect(text()).toContain('2024-01-03'); // the busiest day's date
      expect(button('PNG')).toBeDefined(); // each card exports a poster
    });

    it('picks the oldest cohort that still has live lines', async () => {
      await setState(PUNCH);
      // SURVIVAL's 2019 cohort is fully dead by the tip; 2020 is still alive.
      fixture.componentRef.setInput('survival', SURVIVAL);
      await fixture.whenStable();
      button('Git Wrapped')!.click();
      await fixture.whenStable();
      expect(text()).toContain('Oldest code alive');
      expect(text()).toContain('2020'); // the oldest cohort with live lines…
      expect(text()).not.toContain('2019'); // …not the fully-dead 2019 cohort
    });
  });

  describe('Surprising couplings', () => {
    const DISTANT: CoChangeState = {
      status: 'ready',
      scanned: 2,
      target: 75,
      result: computeCoChange([
        { sha: '1', files: ['src/auth.ts', 'test/e2e.ts'] },
        { sha: '2', files: ['src/auth.ts', 'test/e2e.ts'] },
      ]),
      hotspots: [],
      teamGraph: EMPTY_TEAM_GRAPH,
      knowledge: EMPTY_KNOWLEDGE,
    };

    it('flags strong couplings across distant folders', async () => {
      await setState(DISTANT);
      button('Coupling')!.click();
      await fixture.whenStable();
      expect(text()).toContain('Surprising couplings');
      expect(text()).toContain('e2e.ts');
    });
  });
});
