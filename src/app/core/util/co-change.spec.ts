import { CommitFiles, computeCoChange, relatedFiles } from './co-change';

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
