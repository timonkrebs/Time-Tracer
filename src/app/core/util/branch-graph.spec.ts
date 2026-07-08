import {
  BranchGraph,
  BranchGraphEdge,
  CollapsedNode,
  CommitNode,
  GraphCommit,
  layoutBranchGraph,
  mergedBranchName,
} from './branch-graph';

/** Builds a commit with an author date derived from a numeric tick. */
function commit(sha: string, parents: string[], tick: number): GraphCommit {
  return { sha, parentShas: parents, authoredAt: new Date(tick * 60_000).toISOString() };
}

function commitNode(graph: BranchGraph, sha: string): CommitNode {
  const node = graph.nodes.find((n) => n.kind === 'commit' && n.sha === sha);
  if (!node) throw new Error(`commit node ${sha} not in graph`);
  return node as CommitNode;
}

function pillNodes(graph: BranchGraph): CollapsedNode[] {
  return graph.nodes.filter((n) => n.kind === 'collapsed') as CollapsedNode[];
}

function edgeBetween(graph: BranchGraph, from: number, to: number): BranchGraphEdge | undefined {
  return graph.edges.find((e) => e.fromColumn === from && e.toColumn === to);
}

describe('layoutBranchGraph', () => {
  it('lays a linear history on one lane, oldest at column 0', () => {
    const graph = layoutBranchGraph(
      [commit('c3', ['c2'], 3), commit('c2', ['c1'], 2), commit('c1', [], 1)],
      new Map([['main', 'c3']]),
    );

    expect(graph.lanes).toEqual([
      { index: 0, label: 'main', inferred: false, headSha: 'c3', size: 3 },
    ]);
    expect(graph.columnCount).toBe(3);
    expect(graph.commitCount).toBe(3);
    expect(commitNode(graph, 'c1').column).toBe(0);
    expect(commitNode(graph, 'c2').column).toBe(1);
    expect(commitNode(graph, 'c3').column).toBe(2);
    expect(graph.nodes.every((n) => n.lane === 0)).toBe(true);
    expect(graph.edges).toEqual([
      { fromColumn: 0, fromLane: 0, toColumn: 1, toLane: 0, kind: 'line', colorLane: 0 },
      { fromColumn: 1, fromLane: 0, toColumn: 2, toLane: 0, kind: 'line', colorLane: 0 },
    ]);
  });

  it('gives a merged side branch its own lane with branch and merge edges', () => {
    // main: c1 ← c2 ← M    feature (merged): c1 ← f1 ← f2 ↗ M
    const graph = layoutBranchGraph(
      [
        commit('m', ['c2', 'f2'], 5),
        commit('f2', ['f1'], 4),
        commit('c2', ['c1'], 3),
        commit('f1', ['c1'], 2),
        commit('c1', [], 1),
      ],
      new Map([['main', 'm']]),
    );

    expect(graph.lanes.length).toBe(2);
    expect(graph.lanes[0]).toEqual({
      index: 0,
      label: 'main',
      inferred: false,
      headSha: 'm',
      size: 3,
    });
    expect(graph.lanes[1]).toEqual({
      index: 1,
      label: null,
      inferred: true,
      headSha: 'f2',
      size: 2,
    });

    const m = commitNode(graph, 'm');
    expect(m.isMerge).toBe(true);
    expect(m.lane).toBe(0);
    expect(commitNode(graph, 'f2').lane).toBe(1);
    expect(commitNode(graph, 'f1').lane).toBe(1);

    // Fork off main: c1 → f1 coloured by the side lane.
    const fork = edgeBetween(graph, commitNode(graph, 'c1').column, commitNode(graph, 'f1').column);
    expect(fork).toMatchObject({ kind: 'branch', fromLane: 0, toLane: 1, colorLane: 1 });
    // Merge back into main: f2 → m coloured by the side lane.
    const merge = edgeBetween(graph, commitNode(graph, 'f2').column, m.column);
    expect(merge).toMatchObject({ kind: 'merge', fromLane: 1, toLane: 0, colorLane: 1 });
  });

  it('keeps every column older-left: parents sit left of children', () => {
    const graph = layoutBranchGraph(
      [
        commit('m', ['c2', 'f2'], 5),
        commit('f2', ['f1'], 4),
        commit('c2', ['c1'], 3),
        commit('f1', ['c1'], 2),
        commit('c1', [], 1),
      ],
      new Map([['main', 'm']]),
    );
    for (const edge of graph.edges) {
      expect(edge.fromColumn).toBeLessThan(edge.toColumn);
    }
  });

  it('labels a tip on another lane instead of opening an empty lane', () => {
    // main points into feature's first-parent chain (main is behind feature).
    const graph = layoutBranchGraph(
      [commit('f2', ['f1'], 3), commit('f1', ['c1'], 2), commit('c1', [], 1)],
      new Map([
        ['feature', 'f2'],
        ['main', 'f1'],
      ]),
    );

    expect(graph.lanes.length).toBe(1);
    expect(graph.lanes[0].label).toBe('feature');
    expect(commitNode(graph, 'f2').labels).toEqual(['feature']);
    expect(commitNode(graph, 'f1').labels).toEqual(['main']);
  });

  it('ignores tips whose commits are not loaded', () => {
    const graph = layoutBranchGraph(
      [commit('c1', [], 1)],
      new Map([
        ['main', 'c1'],
        ['ghost', 'nope'],
      ]),
    );
    expect(graph.lanes.length).toBe(1);
    expect(graph.commitCount).toBe(1);
  });

  it('collapses long linear runs into a pill and keeps the ends visible', () => {
    // head ← p1..p5 ← root: the five plain middle commits fold into one pill.
    const commits = [
      commit('head', ['p1'], 7),
      commit('p1', ['p2'], 6),
      commit('p2', ['p3'], 5),
      commit('p3', ['p4'], 4),
      commit('p4', ['p5'], 3),
      commit('p5', ['root'], 2),
      commit('root', [], 1),
    ];
    const graph = layoutBranchGraph(commits, new Map([['main', 'head']]));

    const pills = pillNodes(graph);
    expect(pills.length).toBe(1);
    expect(pills[0]).toMatchObject({
      id: 'p1',
      lane: 0,
      count: 5,
      shas: ['p1', 'p2', 'p3', 'p4', 'p5'],
    });
    expect(graph.columnCount).toBe(3); // root · pill · head
    expect(graph.commitCount).toBe(7);
    expect(commitNode(graph, 'root').column).toBe(0);
    expect(pills[0].column).toBe(1);
    expect(commitNode(graph, 'head').column).toBe(2);
    expect(graph.edges).toEqual([
      { fromColumn: 0, fromLane: 0, toColumn: 1, toLane: 0, kind: 'line', colorLane: 0 },
      { fromColumn: 1, fromLane: 0, toColumn: 2, toLane: 0, kind: 'line', colorLane: 0 },
    ]);
  });

  it('expands a pill back into commits when its id is in `expanded`', () => {
    const commits = [
      commit('head', ['p1'], 7),
      commit('p1', ['p2'], 6),
      commit('p2', ['p3'], 5),
      commit('p3', ['p4'], 4),
      commit('p4', ['p5'], 3),
      commit('p5', ['root'], 2),
      commit('root', [], 1),
    ];
    const graph = layoutBranchGraph(commits, new Map([['main', 'head']]), {
      expanded: new Set(['p1']),
    });

    expect(pillNodes(graph).length).toBe(0);
    expect(graph.columnCount).toBe(7);
  });

  it('does not collapse runs shorter than the threshold', () => {
    const commits = [
      commit('head', ['p1'], 5),
      commit('p1', ['p2'], 4),
      commit('p2', ['p3'], 3),
      commit('p3', ['root'], 2),
      commit('root', [], 1),
    ];
    const graph = layoutBranchGraph(commits, new Map([['main', 'head']]));
    expect(pillNodes(graph).length).toBe(0);
    expect(graph.columnCount).toBe(5);
  });

  it('never folds merge points, fork points or labelled commits into a pill', () => {
    // main: m ← a1 ← a2 ← fork ← a3 ← root, feature branches at `fork` and
    // merges at `m`; every main commit is either an end, a merge or a fork, so
    // the only collapsible run (a1..a2 between m and fork) is too short.
    const commits = [
      commit('m', ['a1', 'f1'], 7),
      commit('f1', ['fork'], 6),
      commit('a1', ['a2'], 5),
      commit('a2', ['fork'], 4),
      commit('fork', ['a3'], 3),
      commit('a3', ['root'], 2),
      commit('root', [], 1),
    ];
    const graph = layoutBranchGraph(commits, new Map([['main', 'm']]));
    expect(pillNodes(graph).length).toBe(0);
    // `fork` has two loaded children (a2 and f1), so it stays visible.
    expect(commitNode(graph, 'fork')).toBeTruthy();
  });

  it('marks commits whose parents fell outside the loaded window as clipped', () => {
    const graph = layoutBranchGraph(
      [commit('c2', ['c1'], 2), commit('c1', ['gone'], 1)],
      new Map([['main', 'c2']]),
    );
    expect(commitNode(graph, 'c1').clipped).toBe(true);
    expect(commitNode(graph, 'c2').clipped).toBe(false);
    expect(graph.edges.length).toBe(1); // no edge into the unloaded parent
  });

  it('roots are not clipped — history genuinely starts there', () => {
    const graph = layoutBranchGraph([commit('c1', [], 1)], new Map([['main', 'c1']]));
    expect(commitNode(graph, 'c1').clipped).toBe(false);
  });

  it('gives a disconnected chain (an added branch) its own lane', () => {
    // dev was loaded from its own tip but shares no loaded commit with main.
    const graph = layoutBranchGraph(
      [
        commit('m2', ['m1'], 4),
        commit('m1', [], 1),
        commit('d2', ['d1'], 3),
        commit('d1', ['gone'], 2),
      ],
      new Map([
        ['main', 'm2'],
        ['dev', 'd2'],
      ]),
    );

    expect(graph.lanes.map((l) => l.label)).toEqual(['main', 'dev']);
    expect(commitNode(graph, 'd2').lane).toBe(1);
    expect(commitNode(graph, 'd1').clipped).toBe(true);
  });

  it('places chains no tip reaches on unnamed lanes instead of dropping them', () => {
    const graph = layoutBranchGraph(
      [commit('m1', [], 1), commit('x2', ['x1'], 3), commit('x1', [], 2)],
      new Map([['main', 'm1']]),
    );
    expect(graph.lanes.length).toBe(2);
    expect(graph.lanes[1]).toMatchObject({ label: null, headSha: 'x2' });
    expect(commitNode(graph, 'x1').lane).toBe(1);
  });

  it('dedupes commits fed twice (overlapping pages)', () => {
    const c1 = commit('c1', [], 1);
    const graph = layoutBranchGraph([commit('c2', ['c1'], 2), c1, c1], new Map([['main', 'c2']]));
    expect(graph.commitCount).toBe(2);
    expect(graph.columnCount).toBe(2);
  });

  it('recovers merged branch names from the summaries the hosts write', () => {
    expect(mergedBranchName('Merge pull request #56 from timonkrebs/claude/branch-explorer')).toBe(
      'claude/branch-explorer',
    );
    expect(mergedBranchName("Merge branch 'feature/foo' into main")).toBe('feature/foo');
    expect(mergedBranchName('Merge branch feature/foo')).toBe('feature/foo');
    expect(mergedBranchName("Merge remote-tracking branch 'origin/fix/bar'")).toBe('fix/bar');
    expect(mergedBranchName('Merged in hotfix/baz (pull request #7)')).toBe('hotfix/baz');
    // Azure DevOps records no branch name; ordinary commits are not merges.
    expect(mergedBranchName('Merged PR 123: fix the thing')).toBeNull();
    expect(mergedBranchName('Add a feature')).toBeNull();
    expect(mergedBranchName(undefined)).toBeNull();
  });

  it('breaks equal timestamps deterministically', () => {
    const a = layoutBranchGraph([commit('b', [], 1), commit('a', [], 1)], new Map([['main', 'b']]));
    const b = layoutBranchGraph([commit('a', [], 1), commit('b', [], 1)], new Map([['main', 'b']]));
    expect(a.nodes.map((n) => (n as CommitNode).sha)).toEqual(
      b.nodes.map((n) => (n as CommitNode).sha),
    );
  });

  it('orders columns topologically even when clocks lie', () => {
    // The parent claims a NEWER date than its child (rebase/amend skew).
    const graph = layoutBranchGraph(
      [commit('child', ['parent'], 1), commit('parent', [], 9)],
      new Map([['main', 'child']]),
    );
    expect(commitNode(graph, 'parent').column).toBe(0);
    expect(commitNode(graph, 'child').column).toBe(1);
  });

  it('names a merged side branch from the merge commit message', () => {
    const graph = layoutBranchGraph(
      [
        { ...commit('m', ['c2', 'f2'], 5), summary: 'Merge pull request #9 from acme/feature/x' },
        commit('f2', ['f1'], 4),
        commit('c2', ['c1'], 3),
        commit('f1', ['c1'], 2),
        commit('c1', [], 1),
      ],
      new Map([['main', 'm']]),
    );

    expect(graph.lanes[1]).toMatchObject({ label: 'feature/x', inferred: true, headSha: 'f2' });
  });

  it('returns an empty graph for no commits', () => {
    const graph = layoutBranchGraph([], new Map());
    expect(graph.lanes).toEqual([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.columnCount).toBe(0);
    expect(graph.commitCount).toBe(0);
  });
});
