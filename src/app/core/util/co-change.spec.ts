import {
  CoChangePair,
  CommitFiles,
  autoModuleDepth,
  clusterCoChange,
  computeCoChange,
  computeModuleCoChange,
  couplingConfidence,
  moduleOf,
  modulePairDrivers,
  pathDistance,
  relatedFiles,
  surprisingCouplings,
} from './co-change';

const COMMITS: CommitFiles[] = [
  { sha: 'c1', files: ['a', 'b'] },
  { sha: 'c2', files: ['a', 'b'] },
  { sha: 'c3', files: ['a', 'c'] },
  { sha: 'c4', files: ['b', 'c'] },
  { sha: 'c5', files: ['a', 'b', 'c'] },
];

describe('computeCoChange', () => {
  it('counts per-file changes and ranks coupled pairs', () => {
    const result = computeCoChange(COMMITS);

    expect(result.commitsUsed).toBe(5);
    expect(result.changes.get('a')).toBe(4);
    expect(result.changes.get('b')).toBe(4);
    expect(result.changes.get('c')).toBe(3);

    // a↔b co-changes in 3 commits; a↔c and b↔c in 2 each.
    expect(result.pairs.map((p) => `${p.a}-${p.b}`)).toEqual(['a-b', 'a-c', 'b-c']);
    expect(result.pairs[0]).toEqual({ a: 'a', b: 'b', support: 3, degree: 0.6 });
  });

  it('drops pairs below the minimum support', () => {
    const result = computeCoChange([...COMMITS, { sha: 'x', files: ['d', 'e'] }]);
    // d↔e occurred once (< default minSupport 2), so it is not coupled.
    expect(result.pairs.some((p) => p.a === 'd' || p.b === 'd')).toBe(false);
    expect(result.changes.get('d')).toBe(1);
  });

  it('ignores commits that touch more files than the cap', () => {
    const result = computeCoChange(
      [
        { sha: 'sweep', files: ['x', 'y', 'z'] },
        { sha: 'n', files: ['x', 'y'] },
        { sha: 'o', files: ['x', 'y'] },
      ],
      { maxCommitFiles: 2, minSupport: 2 },
    );
    expect(result.commitsUsed).toBe(2); // the 3-file "sweep" commit was dropped
    expect(result.changes.get('x')).toBe(2);
    expect(result.changes.get('z')).toBeUndefined();
    expect(result.pairs).toEqual([{ a: 'x', b: 'y', support: 2, degree: 1 }]);
  });

  it('returns an empty result for no commits', () => {
    const result = computeCoChange([]);
    expect(result.commitsUsed).toBe(0);
    expect(result.changes.size).toBe(0);
    expect(result.pairs).toEqual([]);
  });

  it('ranks a strong, well-evidenced pair above a weaker one with more co-changes', () => {
    // p1↔p2 always change together (3 commits, 100%). q1↔q2 co-change more often
    // (4 commits) but q1 churns alone a lot, so their coupling is only ~31%.
    const commits: CommitFiles[] = [
      { sha: 'p-a', files: ['p1', 'p2'] },
      { sha: 'p-b', files: ['p1', 'p2'] },
      { sha: 'p-c', files: ['p1', 'p2'] },
      { sha: 'q-a', files: ['q1', 'q2'] },
      { sha: 'q-b', files: ['q1', 'q2'] },
      { sha: 'q-c', files: ['q1', 'q2'] },
      { sha: 'q-d', files: ['q1', 'q2'] },
    ];
    // q1 also changes alone with a different file each time (those pairs stay below minSupport).
    for (let i = 0; i < 9; i++) commits.push({ sha: `solo-${i}`, files: ['q1', `other${i}`] });

    const result = computeCoChange(commits);
    const order = result.pairs.map((p) => `${p.a}-${p.b}`);
    // Only the two qualifying pairs remain, and the tighter p-pair ranks first —
    // even though q1↔q2 has the higher raw co-change count (4 vs 3).
    expect(order).toEqual(['p1-p2', 'q1-q2']);
    expect(result.pairs[0].support).toBe(3);
    expect(result.pairs[1].support).toBe(4);
  });
});

describe('couplingConfidence', () => {
  it('rewards more evidence at the same coupling ratio', () => {
    // Both are 50% coupling, but 20-of-40 is far better evidenced than 2-of-4.
    expect(couplingConfidence(20, 40)).toBeGreaterThan(couplingConfidence(2, 4));
  });

  it('rewards a higher ratio at equal evidence', () => {
    expect(couplingConfidence(8, 10)).toBeGreaterThan(couplingConfidence(5, 10));
  });

  it('ranks a solid pair above a flimsy "perfect" one', () => {
    // 4-of-4 (100%, more evidence) beats 2-of-2 (100%, thin); both beat a low ratio.
    expect(couplingConfidence(4, 4)).toBeGreaterThan(couplingConfidence(2, 2));
    expect(couplingConfidence(4, 4)).toBeGreaterThan(couplingConfidence(5, 16));
  });

  it('stays within [0, 1] and is 0 for an empty union', () => {
    expect(couplingConfidence(0, 0)).toBe(0);
    expect(couplingConfidence(10, 10)).toBeGreaterThan(0);
    expect(couplingConfidence(10, 10)).toBeLessThanOrEqual(1);
  });
});

describe('relatedFiles', () => {
  it('ranks a file’s companions by how often they ride along', () => {
    const result = computeCoChange(COMMITS);
    const related = relatedFiles(result, 'a');
    expect(related.map((r) => r.path)).toEqual(['b', 'c']);
    expect(related[0]).toEqual({ path: 'b', support: 3, confidence: 0.75 }); // 3 of a's 4 commits
    expect(related[1].confidence).toBe(0.5); // c in 2 of a's 4 commits
  });

  it('honours the limit and ignores unknown files', () => {
    const result = computeCoChange(COMMITS);
    expect(relatedFiles(result, 'a', 1).map((r) => r.path)).toEqual(['b']);
    expect(relatedFiles(result, 'nope')).toEqual([]);
  });
});

describe('clusterCoChange', () => {
  const pairs = [
    { a: 'a', b: 'b', support: 5, degree: 0.8 },
    { a: 'b', b: 'c', support: 4, degree: 0.7 },
    { a: 'x', b: 'y', support: 2, degree: 0.5 },
    { a: 'c', b: 'x', support: 1, degree: 0.1 }, // weak: must not merge the two clusters
  ];

  it('finds connected components, strongest first, ignoring weak links', () => {
    const clusters = clusterCoChange(pairs, { minDegree: 0.3 });
    expect(clusters).toHaveLength(2);

    expect(clusters[0].files).toEqual(['a', 'b', 'c']);
    expect(clusters[0].score).toBe(9); // 5 + 4
    expect(clusters[0].edges).toHaveLength(2);

    expect(clusters[1].files).toEqual(['x', 'y']);
    expect(clusters[1].score).toBe(2);
  });

  it('honours the cluster limit', () => {
    expect(clusterCoChange(pairs, { minDegree: 0.3, limit: 1 })).toHaveLength(1);
  });

  it('drops clusters below the minimum size', () => {
    // x–y is only two files; with minFiles 3 just the a–b–c cluster remains.
    expect(clusterCoChange(pairs, { minDegree: 0.3, minFiles: 3 }).map((c) => c.files)).toEqual([
      ['a', 'b', 'c'],
    ]);
  });

  it('drops super-clusters larger than the size cap', () => {
    const tangled = [
      { a: 'a', b: 'b', support: 3, degree: 0.9 },
      { a: 'b', b: 'c', support: 3, degree: 0.9 },
      { a: 'c', b: 'd', support: 3, degree: 0.9 }, // a–b–c–d: a 4-file hairball
      { a: 'x', b: 'y', support: 5, degree: 0.9 },
    ];
    // With maxFiles 3 the 4-file component is excluded; only x–y survives.
    expect(clusterCoChange(tangled, { minDegree: 0.3, maxFiles: 3 }).map((c) => c.files)).toEqual([
      ['x', 'y'],
    ]);
  });

  it('returns nothing when every coupling is below the degree threshold', () => {
    expect(clusterCoChange(pairs, { minDegree: 0.95 })).toEqual([]);
  });
});

describe('pathDistance', () => {
  it('is 0 for files in the same folder (or both at the root)', () => {
    expect(pathDistance('a.ts', 'b.ts')).toBe(0);
    expect(pathDistance('src/a.ts', 'src/b.ts')).toBe(0);
  });

  it('is 1 for files under unrelated top-level folders', () => {
    expect(pathDistance('src/a.ts', 'test/b.ts')).toBe(1);
  });

  it('is partial for sibling subfolders sharing a parent', () => {
    expect(pathDistance('src/ui/a.ts', 'src/db/b.ts')).toBe(0.5);
  });
});

describe('surprisingCouplings', () => {
  const pairs: CoChangePair[] = [
    { a: 'src/auth.ts', b: 'src/session.ts', support: 9, degree: 0.9 }, // same folder
    { a: 'src/auth.ts', b: 'test/e2e.ts', support: 3, degree: 0.6 }, // distant
    { a: 'src/ui/x.ts', b: 'src/db/y.ts', support: 4, degree: 0.5 }, // sibling subdirs
  ];

  it('keeps only distant pairs, ranked by degree × distance', () => {
    const result = surprisingCouplings(pairs);
    expect(result.map((p) => [p.a, p.b])).toEqual([
      ['src/auth.ts', 'test/e2e.ts'],
      ['src/ui/x.ts', 'src/db/y.ts'],
    ]);
    expect(result[0].distance).toBe(1);
    expect(result[1].distance).toBe(0.5);
  });

  it('honours the limit', () => {
    expect(surprisingCouplings(pairs, { limit: 1 })).toHaveLength(1);
  });
});

describe('moduleOf', () => {
  it('takes the directory prefix at the requested depth', () => {
    expect(moduleOf('src/auth/login.ts', 1)).toBe('src');
    expect(moduleOf('src/auth/login.ts', 2)).toBe('src/auth');
    expect(moduleOf('src/auth/login.ts', 9)).toBe('src/auth'); // deeper than the path
  });

  it('rolls a file up to its own folder when shallower than the depth', () => {
    expect(moduleOf('src/main.ts', 2)).toBe('src');
  });

  it('maps a repository-root file to the empty module', () => {
    expect(moduleOf('README.md', 1)).toBe('');
  });

  it('sanitises a malformed depth to a whole number >= 1', () => {
    expect(moduleOf('src/auth/login.ts', Number.NaN)).toBe('src');
    expect(moduleOf('src/auth/login.ts', 0)).toBe('src');
    expect(moduleOf('src/auth/login.ts', -3)).toBe('src');
    expect(moduleOf('src/auth/login.ts', 2.9)).toBe('src/auth'); // truncated to 2
    expect(moduleOf('src/auth/login.ts', Number.POSITIVE_INFINITY)).toBe('src/auth');
  });
});

describe('computeModuleCoChange', () => {
  const MODULE_COMMITS: CommitFiles[] = [
    { sha: 'm1', files: ['src/auth/a.ts', 'src/ui/b.ts'] },
    { sha: 'm2', files: ['src/auth/a.ts', 'src/ui/c.ts'] },
    { sha: 'm3', files: ['src/auth/a.ts', 'src/auth/d.ts'] }, // within one module
  ];

  it('couples modules that change together, ignoring within-module churn', () => {
    const result = computeModuleCoChange(MODULE_COMMITS, { depth: 2, minSupport: 2 });

    // src/auth changed in all three commits; src/ui in two.
    expect(result.changes.get('src/auth')).toBe(3);
    expect(result.changes.get('src/ui')).toBe(2);
    // m3 touched two files in the same module, so it couples nothing.
    expect(result.pairs).toEqual([{ a: 'src/auth', b: 'src/ui', support: 2, degree: 2 / 3 }]);
  });

  it('re-buckets by depth — a shallower depth merges siblings', () => {
    // At depth 1 everything is just "src", so there is no cross-module coupling.
    const result = computeModuleCoChange(MODULE_COMMITS, { depth: 1, minSupport: 2 });
    expect(result.changes.get('src')).toBe(3);
    expect(result.pairs).toEqual([]);
  });

  it('drops sweeps by their real file count, before the roll-up', () => {
    const sweep: CommitFiles = {
      sha: 'sweep',
      files: Array.from({ length: 30 }, (_, i) => `mod${i}/f.ts`),
    };
    const result = computeModuleCoChange(
      [
        sweep, // 30 files > cap → dropped even though it spans many modules
        { sha: 'n', files: ['a/x.ts', 'b/y.ts'] },
        { sha: 'o', files: ['a/x.ts', 'b/y.ts'] },
      ],
      { depth: 1, minSupport: 2 },
    );
    expect(result.commitsUsed).toBe(2);
    expect(result.pairs).toEqual([{ a: 'a', b: 'b', support: 2, degree: 1 }]);
  });

  it('ignores repository-root files — manifests must not become a module', () => {
    const result = computeModuleCoChange(
      [
        { sha: 'r1', files: ['package.json', 'auth/a.ts', 'ui/x.ts'] },
        { sha: 'r2', files: ['package.json', 'auth/a.ts', 'ui/x.ts'] },
      ],
      { depth: 1, minSupport: 2 },
    );
    expect(result.changes.get('')).toBeUndefined();
    expect(result.pairs).toEqual([{ a: 'auth', b: 'ui', support: 2, degree: 1 }]);
  });
});

describe('autoModuleDepth', () => {
  it('stays at depth 1 when the top-level folders already split the tree', () => {
    expect(
      autoModuleDepth([{ sha: 'c', files: ['auth/a.ts', 'ui/x.ts', 'db/q.ts', 'api/r.ts'] }]),
    ).toBe(1);
  });

  it('digs deeper while a single folder dominates (the src/app funnel)', () => {
    // Everything under src/app → depths 1 and 2 are one blob; 3 splits it.
    const commits: CommitFiles[] = [
      { sha: 'c1', files: ['src/app/core/a.ts', 'src/app/core/b.ts'] },
      { sha: 'c2', files: ['src/app/features/x.ts', 'src/app/features/y.ts'] },
      { sha: 'c3', files: ['src/app/core/c.ts', 'src/app/features/z.ts'] },
    ];
    expect(autoModuleDepth(commits)).toBe(3);
  });

  it('caps at maxDepth when a folder dominates all the way down', () => {
    const commits: CommitFiles[] = [
      { sha: 'c', files: ['a/b/c/d/e/one.ts', 'a/b/c/d/e/two.ts', 'a/b/c/d/e/three.ts'] },
    ];
    expect(autoModuleDepth(commits, { maxDepth: 4 })).toBe(4);
  });

  it('falls back to depth 1 with no groupable (non-root) files', () => {
    expect(autoModuleDepth([])).toBe(1);
    expect(autoModuleDepth([{ sha: 'c', files: ['README.md', 'package.json'] }])).toBe(1);
  });

  it('ignores sweep commits — depth comes from the commits that will be scored', () => {
    // Normal commits all funnel through src/app; a 30-file top-level sweep
    // would make depth 1 look balanced, but the module analysis drops it —
    // counting it here would hide the actual core ↔ features coupling.
    const commits: CommitFiles[] = [
      { sha: 'c1', files: ['src/app/core/a.ts', 'src/app/core/b.ts'] },
      { sha: 'c2', files: ['src/app/features/x.ts', 'src/app/features/y.ts'] },
      { sha: 'c3', files: ['src/app/core/c.ts', 'src/app/features/z.ts'] },
      { sha: 'sweep', files: Array.from({ length: 30 }, (_, i) => `mod${i}/f.ts`) },
    ];
    expect(autoModuleDepth(commits)).toBe(3);
  });
});

describe('modulePairDrivers', () => {
  const commits: CommitFiles[] = [
    ...Array.from({ length: 5 }, (_, i) => ({ sha: `s${i}`, files: ['auth/b.ts', 'ui/y.ts'] })),
    { sha: 'w1', files: ['auth/a.ts', 'ui/x.ts'] },
    { sha: 'w2', files: ['auth/a.ts', 'ui/x.ts'] },
    { sha: 'same', files: ['auth/a.ts', 'auth/b.ts'] }, // same module → no driver
    { sha: 'root', files: ['auth/a.ts', 'package.json'] }, // root → no driver
  ];

  it('buckets cross-module file pairs by the module pair they bridge, strongest first', () => {
    const drivers = modulePairDrivers(commits, 1);

    expect([...drivers.keys()]).toEqual(['auth\nui']);
    const bucket = drivers.get('auth\nui')!;
    expect(bucket.map((p) => [p.a, p.b, p.support])).toEqual([
      ['auth/b.ts', 'ui/y.ts', 5],
      ['auth/a.ts', 'ui/x.ts', 2],
    ]);
    // Degree is the usual Jaccard: auth/b.ts changed 6× in total, ui/y.ts 5×.
    expect(bucket[0].degree).toBeCloseTo(5 / 6);
  });

  it('truncates each bucket to the per-pair cap, keeping the strongest', () => {
    const drivers = modulePairDrivers(commits, 1, { perPair: 1 });
    expect(drivers.get('auth\nui')!.map((p) => p.support)).toEqual([5]);
  });

  it('drops sweep commits, like the module analysis itself', () => {
    const sweep: CommitFiles = {
      sha: 'sweep',
      files: Array.from({ length: 30 }, (_, i) => `mod${i}/f.ts`),
    };
    expect(modulePairDrivers([sweep], 1).size).toBe(0);
  });
});
