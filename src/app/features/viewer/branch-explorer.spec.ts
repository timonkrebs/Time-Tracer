import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CommitInfo } from '../../core/models';
import { BranchGraphState, BranchesState, GraphSizesState } from '../../core/store/repo-store';
import { BranchExplorer } from './branch-explorer';

function commit(sha: string, parents: string[], tick: number): CommitInfo {
  return {
    sha,
    message: `${sha} full message`,
    summary: `${sha} summary`,
    authorName: 'Ada',
    authorEmail: null,
    authoredAt: new Date(tick * 60_000).toISOString(),
    htmlUrl: `https://example.test/commit/${sha}`,
    parentShas: parents,
  };
}

/** main: c1 ← c2 ← m, with f1 ← f2 branched off c1 and merged at m. */
const MERGE_STATE: BranchGraphState = {
  status: 'ready',
  commits: [
    commit('m', ['c2', 'f2'], 5),
    commit('f2', ['f1'], 4),
    commit('c2', ['c1'], 3),
    commit('f1', ['c1'], 2),
    commit('c1', [], 1),
  ],
  heads: new Map([['main', 'm']]),
  hasMore: false,
};

/** head ← p1..p5 ← root — the five middle commits collapse into a pill. */
const LINEAR_STATE: BranchGraphState = {
  status: 'ready',
  commits: [
    commit('head', ['p1'], 7),
    commit('p1', ['p2'], 6),
    commit('p2', ['p3'], 5),
    commit('p3', ['p4'], 4),
    commit('p4', ['p5'], 3),
    commit('p5', ['root'], 2),
    commit('root', [], 1),
  ],
  heads: new Map([['main', 'head']]),
  hasMore: true,
};

const BRANCHES: BranchesState = {
  status: 'ready',
  names: ['dev', 'feature/foo', 'main'],
  truncated: false,
};

/** Change sizes for MERGE_STATE (the merge m gauges against other merges). */
const SIZES: GraphSizesState = {
  status: 'ready',
  sizes: new Map([
    ['m', { additions: 480, deletions: 120, files: 12 }],
    ['c1', { additions: 100, deletions: 50, files: 3 }],
    ['c2', { additions: 2, deletions: 1, files: 1 }],
    ['f1', { additions: 10, deletions: 0, files: 2 }],
    ['f2', { additions: 0, deletions: 0, files: 0 }],
  ]),
  scanned: 5,
  total: 5,
  capped: false,
};

describe('BranchExplorer', () => {
  let fixture: ComponentFixture<BranchExplorer>;
  let loads: number;
  let loadMores: number;
  let sizeLoads: number;
  let parentResolves: number;
  let branchLoads: number;
  let added: string[];
  let browsed: string[];
  let filesRequested: string[];
  let opened: { path: string; sha: string }[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [BranchExplorer],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(BranchExplorer);
    fixture.componentRef.setInput('state', null);
    fixture.componentRef.setInput('branches', null);
    fixture.componentRef.setInput('defaultBranch', 'main');
    loads = 0;
    loadMores = 0;
    sizeLoads = 0;
    parentResolves = 0;
    branchLoads = 0;
    added = [];
    browsed = [];
    filesRequested = [];
    opened = [];
    fixture.componentInstance.load.subscribe(() => loads++);
    fixture.componentInstance.loadMore.subscribe(() => loadMores++);
    fixture.componentInstance.loadSizes.subscribe(() => sizeLoads++);
    fixture.componentInstance.resolveParents.subscribe(() => parentResolves++);
    fixture.componentInstance.loadBranches.subscribe(() => branchLoads++);
    fixture.componentInstance.addBranch.subscribe((name) => added.push(name));
    fixture.componentInstance.browse.subscribe((sha) => browsed.push(sha));
    fixture.componentInstance.filesRequest.subscribe((sha) => filesRequested.push(sha));
    fixture.componentInstance.openFile.subscribe((target) => opened.push(target));
    await fixture.whenStable();
  });

  async function setState(state: BranchGraphState | null): Promise<void> {
    fixture.componentRef.setInput('state', state);
    await fixture.whenStable();
  }

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  /** Commit dots vs collapsed-run pills, told apart by their labels. */
  function dots(): SVGGElement[] {
    return Array.from(root().querySelectorAll('svg g[role="button"]')).filter(
      (g) => !(g as SVGGElement).getAttribute('aria-label')?.includes('click to expand'),
    ) as SVGGElement[];
  }

  function pills(): SVGGElement[] {
    return Array.from(root().querySelectorAll('svg g[role="button"]')).filter((g) =>
      (g as SVGGElement).getAttribute('aria-label')?.includes('click to expand'),
    ) as SVGGElement[];
  }

  function buttonByText(text: string): HTMLButtonElement | undefined {
    return Array.from(root().querySelectorAll('button')).find((b) => b.textContent?.includes(text));
  }

  it('shows a loading state until the graph arrives', () => {
    expect(root().textContent).toContain('Loading the commit graph…');
  });

  it('surfaces a load error and retries via the button', async () => {
    await setState({ status: 'error', message: 'rate limited' });

    expect(root().textContent).toContain('rate limited');
    buttonByText('Try again')!.click();
    expect(loads).toBe(1);
  });

  it('renders a dot per commit, lanes for main and the merged branch', async () => {
    await setState(MERGE_STATE);

    expect(dots().length).toBe(5);
    expect(pills().length).toBe(0);
    expect(root().textContent).toContain('5 commits · 2 lanes');
    expect(root().textContent).toContain('main');
    expect(root().textContent).toContain('merged branch');
  });

  it('opens the detail bar on click, with browse and parent hops', async () => {
    await setState(MERGE_STATE);

    const mergeDot = dots().find((g) => g.getAttribute('aria-label')?.startsWith('m ·'));
    (mergeDot as unknown as HTMLElement).dispatchEvent(new MouseEvent('click'));
    await fixture.whenStable();

    expect(root().textContent).toContain('m summary');
    expect(root().textContent).toContain('Ada');

    buttonByText('Browse this commit')!.click();
    expect(browsed).toEqual(['m']);

    // Hop to the first parent (c2) via its chip.
    buttonByText('c2')!.click();
    await fixture.whenStable();
    expect(root().textContent).toContain('c2 summary');
  });

  it('collapses linear runs into a pill that expands on click', async () => {
    await setState(LINEAR_STATE);

    expect(dots().length).toBe(2); // head + root
    const pill = pills();
    expect(pill.length).toBe(1);
    expect(pill[0].textContent).toContain('5');

    (pill[0] as unknown as HTMLElement).dispatchEvent(new MouseEvent('click'));
    await fixture.whenStable();

    expect(pills().length).toBe(0);
    expect(dots().length).toBe(7);

    buttonByText('Re-collapse runs')!.click();
    await fixture.whenStable();
    expect(pills().length).toBe(1);
  });

  it('offers older pages when the provider has more', async () => {
    await setState(LINEAR_STATE);

    buttonByText('Older commits')!.click();
    expect(loadMores).toBe(1);
  });

  it('adds a branch through the dropdown, hiding already-loaded tips', async () => {
    await setState(MERGE_STATE);
    fixture.componentRef.setInput('branches', BRANCHES);
    await fixture.whenStable();

    buttonByText('Add branch')!.click();
    await fixture.whenStable();
    expect(branchLoads).toBe(1);

    const options = Array.from(root().querySelectorAll('li button')).map((b) =>
      b.textContent?.trim(),
    );
    // `main` is already in the graph, so only the others are offered.
    expect(options.some((t) => t?.includes('dev'))).toBe(true);
    expect(options.some((t) => t?.includes('main'))).toBe(false);

    (Array.from(root().querySelectorAll('li button')) as HTMLButtonElement[])
      .find((b) => b.textContent?.includes('dev'))!
      .click();
    await fixture.whenStable();
    expect(added).toEqual(['dev']);
  });

  it('flags a partial graph when the state carries a message', async () => {
    await setState({ ...MERGE_STATE, message: 'ghost: not found' });
    expect(root().textContent).toContain('partial graph');
  });

  it('offers commit sizing and renders fill levels once sizes arrive', async () => {
    await setState(MERGE_STATE);

    buttonByText('Commit sizes')!.click();
    expect(sizeLoads).toBe(1);

    fixture.componentRef.setInput('sizes', SIZES);
    await fixture.whenStable();

    // c1 (the largest regular change) carries a bottom-up fill gauge.
    const c1 = dots().find((g) => g.getAttribute('aria-label')?.startsWith('c1 ·'))!;
    expect(c1.querySelector('rect')).toBeTruthy();
    // f2 changed nothing — an empty ring.
    const f2 = dots().find((g) => g.getAttribute('aria-label')?.startsWith('f2 ·'))!;
    expect(f2.querySelector('rect')).toBeNull();
    // The merge gauges against other merges and keeps a marker double ring.
    const m = dots().find((g) => g.getAttribute('aria-label')?.startsWith('m ·'))!;
    expect(m.querySelector('rect')).toBeTruthy();
    expect(m.querySelectorAll('circle').length).toBe(3); // double ring + ring + clip
    expect(root().textContent).toContain('dot fill = lines changed');
  });

  it('shows sizing progress and the selected commit’s change size', async () => {
    await setState(MERGE_STATE);
    fixture.componentRef.setInput('sizes', {
      ...SIZES,
      status: 'sizing',
      scanned: 2,
    } satisfies GraphSizesState);
    await fixture.whenStable();
    expect(root().textContent).toContain('Sizing 2/5…');

    fixture.componentRef.setInput('sizes', SIZES);
    const c1 = dots().find((g) => g.getAttribute('aria-label')?.startsWith('c1 ·'))!;
    (c1 as unknown as HTMLElement).dispatchEvent(new MouseEvent('click'));
    await fixture.whenStable();

    expect(root().textContent).toContain('+100');
    expect(root().textContent).toContain('−50');
    expect(root().textContent).toContain('3 files');
  });

  it('offers to connect commits when the listing omitted parents', async () => {
    await setState({ ...MERGE_STATE, parentsMissing: true });

    expect(root().textContent).toContain('unlinked commits');
    buttonByText('Connect commits')!.click();
    expect(parentResolves).toBe(1);
  });

  it('names a merged lane from the merge commit message', async () => {
    const named = {
      ...MERGE_STATE,
      commits: MERGE_STATE.commits.map((c) =>
        c.sha === 'm' ? { ...c, summary: "Merge branch 'feature/foo'" } : c,
      ),
    };
    await setState(named);

    expect(root().textContent).toContain('feature/foo');
    expect(root().textContent).not.toContain('merged branch');
  });

  it('requests changed files on selection and opens a file from the panel', async () => {
    await setState(MERGE_STATE);

    const c2 = dots().find((g) => g.getAttribute('aria-label')?.startsWith('c2 ·'))!;
    (c2 as unknown as HTMLElement).dispatchEvent(new MouseEvent('click'));
    await fixture.whenStable();
    expect(filesRequested).toEqual(['c2']);

    fixture.componentRef.setInput(
      'commitFiles',
      new Map([
        [
          'c2',
          {
            status: 'ready' as const,
            files: [
              { path: 'src/app.ts', status: 'modified', additions: 4, deletions: 2 },
              { path: 'docs/new.md', status: 'added' },
            ],
          },
        ],
      ]),
    );
    await fixture.whenStable();

    buttonByText('Files (2)')!.click();
    await fixture.whenStable();
    expect(root().textContent).toContain('src/app.ts');
    expect(root().textContent).toContain('docs/new.md');

    (Array.from(root().querySelectorAll('li button')) as HTMLButtonElement[])
      .find((b) => b.textContent?.includes('src/app.ts'))!
      .click();
    expect(opened).toEqual([{ path: 'src/app.ts', sha: 'c2' }]);
  });

  it('shows tag chips and pins tagged commits out of collapsed runs', async () => {
    await setState(LINEAR_STATE);
    expect(pills().length).toBe(1); // p1..p5 folded

    fixture.componentRef.setInput('tags', {
      status: 'ready' as const,
      bySha: new Map([['p3', ['v1.0.0']]]),
      truncated: false,
    });
    await fixture.whenStable();

    // The tagged commit stays visible, splitting the run below the threshold.
    expect(pills().length).toBe(0);
    expect(root().textContent).toContain('v1.0.0');
  });

  it('compares two commits with ahead/behind counts and dims the rest', async () => {
    await setState(MERGE_STATE);

    const c2 = dots().find((g) => g.getAttribute('aria-label')?.startsWith('c2 ·'))!;
    (c2 as unknown as HTMLElement).dispatchEvent(new MouseEvent('click'));
    await fixture.whenStable();
    buttonByText('Compare from here')!.click();
    await fixture.whenStable();
    expect(root().textContent).toContain('click the other commit');

    const f2 = dots().find((g) => g.getAttribute('aria-label')?.startsWith('f2 ·'))!;
    (f2 as unknown as HTMLElement).dispatchEvent(new MouseEvent('click'));
    await fixture.whenStable();

    // f2 vs c2: f2 carries f1+f2 on top and is missing c2.
    expect(root().textContent).toContain('2 ahead');
    expect(root().textContent).toContain('1 behind');

    // Shared history (c1) and unrelated commits (m) fade out.
    const c1 = dots().find((g) => g.getAttribute('aria-label')?.startsWith('c1 ·'))!;
    const m = dots().find((g) => g.getAttribute('aria-label')?.startsWith('m ·'))!;
    expect(c1.getAttribute('opacity')).toBe('0.2');
    expect(m.getAttribute('opacity')).toBe('0.2');
    const f1 = dots().find((g) => g.getAttribute('aria-label')?.startsWith('f1 ·'))!;
    expect(f1.getAttribute('opacity')).toBe('1');

    buttonByText('Clear')!.click();
    await fixture.whenStable();
    expect(dots().every((g) => g.getAttribute('opacity') === '1')).toBe(true);
  });

  it('hides the provider link for commits without a web URL (local repos)', async () => {
    const local = {
      ...MERGE_STATE,
      commits: MERGE_STATE.commits.map((c) => ({ ...c, htmlUrl: '' })),
    };
    await setState(local);

    (dots()[0] as unknown as HTMLElement).dispatchEvent(new MouseEvent('click'));
    await fixture.whenStable();

    expect(root().textContent).toContain('Browse this commit');
    expect(root().textContent).not.toContain('Open ↗');
  });
});
