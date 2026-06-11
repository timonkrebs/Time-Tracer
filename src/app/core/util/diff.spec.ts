import { DiffOp, buildHunks, computeFileDiff, diffLines, lineSimilarity, splitLines } from './diff';

/** Brute-force LCS length — reference for checking minimality of the script. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  const dp: number[] = new Array((a.length + 1) * (b.length + 1)).fill(0);
  const w = b.length + 1;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i * w + j] =
        a[i - 1] === b[j - 1]
          ? dp[(i - 1) * w + j - 1] + 1
          : Math.max(dp[(i - 1) * w + j], dp[i * w + j - 1]);
    }
  }
  return dp[a.length * w + b.length];
}

function reconstruct(ops: readonly DiffOp[]): { olds: string[]; news: string[] } {
  const olds: string[] = [];
  const news: string[] = [];
  for (const op of ops) {
    if (op.kind !== 'add') olds.push(op.text);
    if (op.kind !== 'remove') news.push(op.text);
  }
  return { olds, news };
}

function editCost(ops: readonly DiffOp[]): number {
  return ops.filter((op) => op.kind !== 'equal').length;
}

/** Deterministic PRNG so the randomized suite is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('splitLines', () => {
  it('treats an empty file as zero lines', () => {
    expect(splitLines('')).toEqual([]);
  });

  it('does not count a single trailing newline as a line', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
  });

  it('keeps a file of one empty line distinct from an empty file', () => {
    expect(splitLines('\n')).toEqual(['']);
  });
});

describe('diffLines', () => {
  it('handles both sides empty', () => {
    expect(diffLines([], [])).toEqual([]);
  });

  it('marks everything added for an empty old side', () => {
    expect(diffLines([], ['a', 'b'])).toEqual([
      { kind: 'add', text: 'a', newLine: 1 },
      { kind: 'add', text: 'b', newLine: 2 },
    ]);
  });

  it('marks everything removed for an empty new side', () => {
    expect(diffLines(['a'], [])).toEqual([{ kind: 'remove', text: 'a', oldLine: 1 }]);
  });

  it('emits only equals for identical inputs', () => {
    const ops = diffLines(['a', 'b'], ['a', 'b']);
    expect(ops.every((op) => op.kind === 'equal')).toBe(true);
  });

  it('diffs a single changed line with correct numbering', () => {
    expect(diffLines(['a', 'x', 'c'], ['a', 'y', 'c'])).toEqual([
      { kind: 'equal', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'remove', text: 'x', oldLine: 2 },
      { kind: 'add', text: 'y', newLine: 2 },
      { kind: 'equal', text: 'c', oldLine: 3, newLine: 3 },
    ]);
  });

  it('finds a minimal script for interleaved changes', () => {
    const a = ['1', '2', '3', '4', '5', '6'];
    const b = ['1', 'x', '3', '4', 'y', '5', '6'];
    const ops = diffLines(a, b);
    expect(editCost(ops)).toBe(a.length + b.length - 2 * lcsLength(a, b));
    const { olds, news } = reconstruct(ops);
    expect(olds).toEqual(a);
    expect(news).toEqual(b);
  });

  it('handles repeated lines (classic Myers worst case shapes)', () => {
    const a = ['a', 'b', 'a', 'b', 'a'];
    const b = ['b', 'a', 'b', 'a', 'b'];
    const ops = diffLines(a, b);
    expect(editCost(ops)).toBe(a.length + b.length - 2 * lcsLength(a, b));
    const { olds, news } = reconstruct(ops);
    expect(olds).toEqual(a);
    expect(news).toEqual(b);
  });

  it('produces minimal, reconstructable scripts on 200 randomized cases', () => {
    const rand = mulberry32(0xc0ffee);
    const alphabet = ['fn', 'let', '}', '{', 'return', ''];
    for (let iter = 0; iter < 200; iter++) {
      const n = Math.floor(rand() * 30);
      const m = Math.floor(rand() * 30);
      const a = Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]);
      const b = Array.from({ length: m }, () => alphabet[Math.floor(rand() * alphabet.length)]);

      const ops = diffLines(a, b);
      const { olds, news } = reconstruct(ops);
      expect(olds).toEqual(a);
      expect(news).toEqual(b);
      expect(editCost(ops)).toBe(n + m - 2 * lcsLength(a, b));
    }
  });
});

describe('computeFileDiff / buildHunks', () => {
  it('reports identical content with no hunks', () => {
    const diff = computeFileDiff('a\nb\n', 'a\nb\n');
    expect(diff.identical).toBe(true);
    expect(diff.hunks).toEqual([]);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
  });

  it('counts added and removed lines', () => {
    const diff = computeFileDiff('a\nb\nc\n', 'a\nx\ny\nc\n');
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.oldLineCount).toBe(3);
    expect(diff.newLineCount).toBe(4);
  });

  it('pads hunks with context and writes a unified header', () => {
    const oldText = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n');
    const newText = ['1', '2', '3', '4', 'FIVE', '6', '7', '8', '9'].join('\n');
    const diff = computeFileDiff(oldText, newText, 2);

    expect(diff.hunks).toHaveLength(1);
    const hunk = diff.hunks[0];
    expect(hunk.header).toBe('@@ -3,5 +3,5 @@');
    expect(hunk.ops.map((op) => op.kind)).toEqual([
      'equal',
      'equal',
      'remove',
      'add',
      'equal',
      'equal',
    ]);
  });

  it('merges changes that are closer than twice the context', () => {
    const oldLines = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
    const newLines = [...oldLines];
    newLines[1] = 'B';
    newLines[6] = 'G';
    const diff = computeFileDiff(oldLines.join('\n'), newLines.join('\n'), 3);
    expect(diff.hunks).toHaveLength(1);
  });

  it('splits changes that are far apart into separate hunks', () => {
    const oldLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines[1] = 'changed early';
    newLines[27] = 'changed late';
    const diff = computeFileDiff(oldLines.join('\n'), newLines.join('\n'), 3);
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[0].oldStart).toBe(1);
    expect(diff.hunks[1].oldStart).toBe(25);
  });

  it('anchors a pure insertion at the preceding line', () => {
    const ops = diffLines(['a', 'b'], ['a', 'x', 'b']);
    const hunks = buildHunks(ops, 0);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].header).toBe('@@ -1,0 +2,1 @@');
  });

  it('diffs a file created from nothing as one all-add hunk', () => {
    const diff = computeFileDiff('', 'a\nb\n');
    expect(diff.hunks).toHaveLength(1);
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(0);
    expect(diff.hunks[0].ops.every((op) => op.kind === 'add')).toBe(true);
  });
});

describe('lineSimilarity', () => {
  it('is 1 for identical content and for two empty files', () => {
    expect(lineSimilarity('a\nb\n', 'a\nb\n')).toBe(1);
    expect(lineSimilarity('', '')).toBe(1);
  });

  it('is 0 for entirely different content', () => {
    expect(lineSimilarity('a\nb\n', 'x\ny\n')).toBe(0);
  });

  it('reflects the shared fraction of lines', () => {
    expect(lineSimilarity('a\nb\n', 'a\nb\nc\n')).toBeCloseTo(2 / 3);
  });
});
