import { TreeEntry } from '../models';
import { OwnedLine, selectOwnershipFiles, summarizeOwnership } from './ownership';

function line(authorName: string, authoredAt: string, sha = authorName + authoredAt): OwnedLine {
  return { commit: { sha, authorName, authoredAt } };
}

describe('summarizeOwnership', () => {
  it('returns an empty summary for no lines', () => {
    const s = summarizeOwnership([]);
    expect(s).toEqual({
      totalLines: 0,
      attributedLines: 0,
      olderLines: 0,
      pendingLines: 0,
      authors: [],
      busFactor: 0,
      latest: null,
    });
  });

  it('computes per-author share, sorted by lines', () => {
    const s = summarizeOwnership([
      line('Ada', '2020-01-01T00:00:00Z'),
      line('Ada', '2021-01-01T00:00:00Z'),
      line('Ada', '2022-01-01T00:00:00Z'),
      line('Bob', '2023-01-01T00:00:00Z'),
    ]);
    expect(s.attributedLines).toBe(4);
    expect(s.authors.map((a) => a.name)).toEqual(['Ada', 'Bob']);
    expect(s.authors[0]).toMatchObject({ name: 'Ada', lines: 3, share: 0.75 });
    expect(s.authors[1]).toMatchObject({ name: 'Bob', lines: 1, share: 0.25 });
  });

  it('counts older and pending lines separately from attributed ones', () => {
    const s = summarizeOwnership([line('Ada', '2020-01-01T00:00:00Z'), 'older', null, null]);
    expect(s.totalLines).toBe(4);
    expect(s.attributedLines).toBe(1);
    expect(s.olderLines).toBe(1);
    expect(s.pendingLines).toBe(2);
  });

  it('reports a bus factor of 1 when one author owns the majority', () => {
    const s = summarizeOwnership([
      line('Ada', '2020-01-01T00:00:00Z'),
      line('Ada', '2020-01-01T00:00:00Z'),
      line('Ada', '2020-01-01T00:00:00Z'),
      line('Bob', '2020-01-01T00:00:00Z'),
    ]);
    expect(s.busFactor).toBe(1);
  });

  it('needs both authors at an even split', () => {
    const s = summarizeOwnership([
      line('Ada', '2020-01-01T00:00:00Z'),
      line('Ada', '2020-01-01T00:00:00Z'),
      line('Bob', '2020-01-01T00:00:00Z'),
      line('Bob', '2020-01-01T00:00:00Z'),
    ]);
    expect(s.busFactor).toBe(2);
  });

  it('tracks the latest commit per author and overall', () => {
    const s = summarizeOwnership([
      line('Ada', '2020-01-01T00:00:00Z', 'a1'),
      line('Ada', '2024-06-01T00:00:00Z', 'a2'),
      line('Bob', '2022-01-01T00:00:00Z', 'b1'),
    ]);
    expect(s.latest).toEqual({ authorName: 'Ada', authoredAt: '2024-06-01T00:00:00Z', sha: 'a2' });
    expect(s.authors.find((a) => a.name === 'Ada')?.lastSha).toBe('a2');
    expect(s.authors.find((a) => a.name === 'Bob')?.lastSha).toBe('b1');
  });
});

function file(path: string, size: number): TreeEntry {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'file', sha: path, size };
}

function dir(path: string): TreeEntry {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'dir', sha: '' };
}

describe('selectOwnershipFiles', () => {
  const entries: TreeEntry[] = [
    file('src/app/small.ts', 10),
    file('src/app/big.ts', 90),
    file('src/app/mid.ts', 50),
    dir('src/app'),
    file('src/appx/other.ts', 999), // sibling folder with a confusable prefix
    file('src/main.ts', 5),
    file('docs/readme.md', 200),
  ];

  it('keeps only the files directly under the folder, largest first', () => {
    const { files, capped } = selectOwnershipFiles(entries, 'src/app', 100);
    expect(files.map((f) => f.path)).toEqual([
      'src/app/big.ts',
      'src/app/mid.ts',
      'src/app/small.ts',
    ]);
    expect(capped).toBe(false);
  });

  it('caps to the largest files and reports the cut', () => {
    const { files, capped } = selectOwnershipFiles(entries, 'src/app', 2);
    expect(files.map((f) => f.path)).toEqual(['src/app/big.ts', 'src/app/mid.ts']);
    expect(capped).toBe(true);
  });

  it('treats the empty folder path as the whole repository', () => {
    const { files } = selectOwnershipFiles(entries, '', 100);
    expect(files.map((f) => f.path)).toEqual([
      'src/appx/other.ts',
      'docs/readme.md',
      'src/app/big.ts',
      'src/app/mid.ts',
      'src/app/small.ts',
      'src/main.ts',
    ]);
  });

  it('orders files with an unknown size last', () => {
    const mixed: TreeEntry[] = [
      { path: 'a.ts', name: 'a.ts', kind: 'file', sha: 'a' }, // no size
      file('b.ts', 1),
    ];
    expect(selectOwnershipFiles(mixed, '', 100).files.map((f) => f.path)).toEqual(['b.ts', 'a.ts']);
  });
});
