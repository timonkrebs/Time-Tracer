import { TreeEntry } from '../models';
import {
  OwnedLine,
  computeOwnershipRisk,
  selectOwnershipFiles,
  summarizeOwnership,
} from './ownership';

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

  it('caps to the largest files and reports the cut and pre-cap total', () => {
    const { files, capped, total } = selectOwnershipFiles(entries, 'src/app', 2);
    expect(files.map((f) => f.path)).toEqual(['src/app/big.ts', 'src/app/mid.ts']);
    expect(capped).toBe(true);
    expect(total).toBe(3); // three files matched before the cap
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

describe('computeOwnershipRisk', () => {
  const DAY = 86_400_000;
  const YEAR = 365;
  const NOW = Date.parse('2026-06-14T00:00:00Z');
  const ago = (days: number): string => new Date(NOW - days * DAY).toISOString();
  const ln = (author: string, days: number): OwnedLine => line(author, ago(days));
  const lines = (author: string, days: number, count: number): OwnedLine[] =>
    Array.from({ length: count }, () => ln(author, days));

  it('ranks a small file of ancient code above a big file of recent code', () => {
    const risks = computeOwnershipRisk(
      [
        { path: 'src/big-recent.ts', lines: lines('Ada', YEAR, 50) },
        { path: 'src/small-ancient.ts', lines: lines('Gone', 10 * YEAR, 10) },
      ],
      { now: NOW },
    );

    // Age beats size: the decade-old 10-line file outranks the year-old 50-line one.
    expect(risks[0].path).toBe('src/small-ancient.ts');
    const ancient = risks.find((r) => r.path === 'src/small-ancient.ts')!;
    const recent = risks.find((r) => r.path === 'src/big-recent.ts')!;
    expect(ancient.staleShare).toBeGreaterThan(0.9);
    expect(recent.staleShare).toBeLessThan(0.4);
  });

  it('counterbalances size sub-linearly: 4× the lines is ~2× the risk', () => {
    const risks = computeOwnershipRisk(
      [
        { path: 'big.ts', lines: lines('Gone', 1000, 400) },
        { path: 'small.ts', lines: lines('Gone', 1000, 100) },
      ],
      { now: NOW },
    );
    const big = risks.find((r) => r.path === 'big.ts')!;
    const small = risks.find((r) => r.path === 'small.ts')!;
    expect(big.staleShare).toBeCloseTo(small.staleShare, 5); // same age
    expect(big.riskScore / small.riskScore).toBeCloseTo(2, 1); // √(400/100) = 2
  });

  it('scores freshly-edited code near zero', () => {
    const risks = computeOwnershipRisk([{ path: 'fresh.ts', lines: lines('Ada', 5, 3) }], {
      now: NOW,
    });
    expect(risks[0].staleShare).toBeLessThan(0.02);
  });

  it('names the primary line owner and when they last touched it', () => {
    const risks = computeOwnershipRisk(
      [{ path: 'x.ts', lines: [ln('Gone', 3000), ln('Gone', 3200), ln('Other', 3100)] }],
      { now: NOW },
    );
    expect(risks[0].owner?.name).toBe('Gone'); // 2 lines vs Other's 1
    expect(risks[0].owner?.lastAuthoredAt).toBe(ago(3000)); // their most recent line
  });

  it('ignores older and pending lines', () => {
    const risks = computeOwnershipRisk(
      [{ path: 'x.ts', lines: [ln('Gone', 3650), 'older', null] }],
      {
        now: NOW,
      },
    );
    expect(risks[0].attributedLines).toBe(1);
  });

  it('skips undated blame lines instead of scoring them as ancient', () => {
    const risks = computeOwnershipRisk(
      [{ path: 'mixed.ts', lines: [ln('Ada', 5), line('Ghost', '')] }],
      {
        now: NOW,
      },
    );
    // The undated line is dropped, not treated as epoch-old…
    expect(risks[0].attributedLines).toBe(1);
    // …so a fresh file isn't dragged toward 100% stale by it.
    expect(risks[0].staleShare).toBeLessThan(0.02);
    expect(risks[0].owner?.name).toBe('Ada');
  });
});
