import {
  CommitFiles,
  clusterCoChange,
  computeCoChange,
  computeModuleCoChange,
  moduleOf,
  relatedFiles,
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

  it('sanitises a malformed depth to a whole number ≥ 1', () => {
    expect(moduleOf('src/auth/login.ts', Number.NaN)).toBe('src');
    expect(moduleOf('src/auth/login.ts', 0)).toBe('src');
    expect(moduleOf('src/auth/login.ts', -3)).toBe('src');
    expect(moduleOf('src/auth/login.ts', 2.9)).toBe('src/auth'); // truncated to 2
    expect(moduleOf('src/auth/login.ts', Number.POSITIVE_INFINITY)).toBe('src/auth');
  });
});

describe('computeModuleCoChange', () => {
  const COMMITS: CommitFiles[] = [
    { sha: 'm1', files: ['src/auth/a.ts', 'src/ui/b.ts'] },
    { sha: 'm2', files: ['src/auth/a.ts', 'src/ui/c.ts'] },
    { sha: 'm3', files: ['src/auth/a.ts', 'src/auth/d.ts'] }, // within one module
  ];

  it('couples modules that change together, ignoring within-module churn', () => {
    const result = computeModuleCoChange(COMMITS, { depth: 2, minSupport: 2 });

    // src/auth changed in all three commits; src/ui in two.
    expect(result.changes.get('src/auth')).toBe(3);
    expect(result.changes.get('src/ui')).toBe(2);
    // m3 touched two files in the same module, so it couples nothing.
    expect(result.pairs).toEqual([{ a: 'src/auth', b: 'src/ui', support: 2, degree: 2 / 3 }]);
  });

  it('re-buckets by depth — a shallower depth merges siblings', () => {
    // At depth 1 everything is just "src", so there is no cross-module coupling.
    const result = computeModuleCoChange(COMMITS, { depth: 1, minSupport: 2 });
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
});
