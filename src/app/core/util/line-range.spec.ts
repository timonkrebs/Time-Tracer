import { computeFileDiff, diffLines, splitLines } from './diff';
import {
  LineRange,
  changeRegions,
  formatLineRange,
  hunkChangeRanges,
  hunkChangedRange,
  mapRangeToParent,
  parseLineRange,
  regionTouchesRange,
} from './line-range';

function regionsOf(oldText: string, newText: string) {
  return changeRegions(diffLines(splitLines(oldText), splitLines(newText)));
}

describe('changeRegions', () => {
  it('returns nothing for identical inputs', () => {
    expect(regionsOf('a\nb\n', 'a\nb\n')).toEqual([]);
  });

  it('describes a replacement with both sides', () => {
    expect(regionsOf('a\nb\nc\n', 'a\nX\nc\n')).toEqual([
      { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 },
    ]);
  });

  it('describes a pure insertion with an empty old side', () => {
    expect(regionsOf('a\nb\n', 'a\nX\nY\nb\n')).toEqual([
      { oldStart: 2, oldCount: 0, newStart: 2, newCount: 2 },
    ]);
  });

  it('describes a pure removal with an empty new side', () => {
    expect(regionsOf('a\nb\nc\n', 'a\nc\n')).toEqual([
      { oldStart: 2, oldCount: 1, newStart: 2, newCount: 0 },
    ]);
  });

  it('keeps separate change runs as separate regions', () => {
    expect(regionsOf('a\nb\nc\nd\ne\n', 'A\nb\nc\nd\nE\n')).toEqual([
      { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
      { oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 },
    ]);
  });
});

describe('regionTouchesRange', () => {
  const range: LineRange = { start: 5, end: 8 };

  it('detects overlap with a replaced block', () => {
    expect(regionTouchesRange({ oldStart: 1, oldCount: 2, newStart: 8, newCount: 3 }, range)).toBe(
      true,
    );
    expect(regionTouchesRange({ oldStart: 1, oldCount: 2, newStart: 9, newCount: 3 }, range)).toBe(
      false,
    );
    expect(regionTouchesRange({ oldStart: 1, oldCount: 2, newStart: 1, newCount: 5 }, range)).toBe(
      true,
    );
    expect(regionTouchesRange({ oldStart: 1, oldCount: 2, newStart: 1, newCount: 4 }, range)).toBe(
      false,
    );
  });

  it('treats a removal gap inside the range as touching', () => {
    // Gap between new lines 5 and 6.
    expect(regionTouchesRange({ oldStart: 6, oldCount: 2, newStart: 6, newCount: 0 }, range)).toBe(
      true,
    );
    // Gap between 8 and 9 — below the last range line.
    expect(regionTouchesRange({ oldStart: 9, oldCount: 1, newStart: 9, newCount: 0 }, range)).toBe(
      false,
    );
    // Gap between 4 and 5 — at the range start.
    expect(regionTouchesRange({ oldStart: 5, oldCount: 1, newStart: 5, newCount: 0 }, range)).toBe(
      true,
    );
  });
});

describe('mapRangeToParent', () => {
  it('maps one-to-one when nothing changed before the range', () => {
    const regions = regionsOf('a\nb\nc\nd\n', 'a\nb\nc\nd\nE\n');
    expect(mapRangeToParent(regions, { start: 2, end: 3 })).toEqual({ start: 2, end: 3 });
  });

  it('shifts by insertions and removals above the range', () => {
    // Two lines inserted at the top: new 5..6 were old 3..4.
    const inserted = regionsOf('a\nb\nc\n', 'X\nY\na\nb\nc\n');
    expect(mapRangeToParent(inserted, { start: 5, end: 5 })).toEqual({ start: 3, end: 3 });
    // One line removed at the top: new 1..2 were old 2..3.
    const removed = regionsOf('a\nb\nc\n', 'b\nc\n');
    expect(mapRangeToParent(removed, { start: 1, end: 2 })).toEqual({ start: 2, end: 3 });
  });

  it('maps a single line inside a replaced block to its positional predecessor', () => {
    // Old 2..5 replaced by new 2..3.
    const regions = regionsOf('a\nb\nc\nd\ne\nf\n', 'a\nX\nY\nf\n');
    // New 3 (Y) is at offset 1 of the new block → old 3, not the whole 2..5:
    // a single traced line keeps following a single line.
    expect(mapRangeToParent(regions, { start: 3, end: 3 })).toEqual({ start: 3, end: 3 });
    // New 2 (X, offset 0) → old 2.
    expect(mapRangeToParent(regions, { start: 2, end: 2 })).toEqual({ start: 2, end: 2 });
  });

  it('keeps a single line single when a block collapses to one line', () => {
    // Old 2..5 (four lines) collapse into the single new line 2.
    const regions = regionsOf('a\nb\nc\nd\ne\nf\n', 'a\nZ\nf\n');
    expect(mapRangeToParent(regions, { start: 2, end: 2 })).toEqual({ start: 2, end: 2 });
  });

  it('expands a multi-line range over a replaced block to keep it whole', () => {
    // Old 2..5 replaced by new 2..3; the range keeps covering the block.
    const regions = regionsOf('a\nb\nc\nd\ne\nf\n', 'a\nX\nY\nf\n');
    expect(mapRangeToParent(regions, { start: 2, end: 3 })).toEqual({ start: 2, end: 5 });
    // A range only reaching into the block still expands to the block's end.
    expect(mapRangeToParent(regions, { start: 1, end: 2 })).toEqual({ start: 1, end: 5 });
  });

  it('covers a removal gap inside the range', () => {
    // Old 3..4 removed; gap between new 2 and 3.
    const regions = regionsOf('a\nb\nx\ny\nc\n', 'a\nb\nc\n');
    expect(mapRangeToParent(regions, { start: 2, end: 3 })).toEqual({ start: 2, end: 5 });
  });

  it('returns null when the range was introduced by this diff', () => {
    const regions = regionsOf('a\nb\n', 'a\nX\nY\nb\n');
    expect(mapRangeToParent(regions, { start: 2, end: 3 })).toBeNull();
  });

  it('keeps the surviving part of a partially introduced range', () => {
    const regions = regionsOf('a\nb\n', 'a\nX\nY\nb\n');
    // New 1 (old) + new 2..3 (introduced): only line 1 survives.
    expect(mapRangeToParent(regions, { start: 1, end: 3 })).toEqual({ start: 1, end: 1 });
  });
});

describe('hunkChangedRange', () => {
  function hunksOf(oldText: string, newText: string) {
    return computeFileDiff(oldText, newText).hunks;
  }

  it('covers exactly the added lines, not the context', () => {
    const [hunk] = hunksOf('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nc\nd\nX\nf\ng\nh\n');
    expect(hunk.header).toBe('@@ -2,7 +2,7 @@');
    expect(hunkChangedRange(hunk)).toEqual({ start: 5, end: 5 });
  });

  it('covers a replacement without reaching its neighbours', () => {
    const [hunk] = hunksOf('a\nb\nc\n', 'a\nX\nc\n');
    expect(hunkChangedRange(hunk)).toEqual({ start: 2, end: 2 });
  });

  it('covers the lines around a removal gap', () => {
    const [hunk] = hunksOf('a\nb\nc\nd\n', 'a\nd\n');
    // b and c were removed between new lines 1 and 2.
    expect(hunkChangedRange(hunk)).toEqual({ start: 1, end: 2 });
  });

  it('anchors a removal at the top of the file to line 1', () => {
    const [hunk] = hunksOf('x\na\nb\n', 'a\nb\n');
    expect(hunkChangedRange(hunk)).toEqual({ start: 1, end: 1 });
  });

  it('reaches one past the end for a removal at the bottom', () => {
    const [hunk] = hunksOf('a\nb\nx\n', 'a\nb\n');
    expect(hunkChangedRange(hunk)).toEqual({ start: 2, end: 3 });
  });

  it('spans all change runs of a merged hunk', () => {
    // Two edits two lines apart merge into one hunk (context 3).
    const [hunk] = hunksOf('a\nb\nc\nd\ne\n', 'A\nb\nc\nd\nE\n');
    expect(hunkChangedRange(hunk)).toEqual({ start: 1, end: 5 });
  });

  it('keeps separate run ranges inside a merged hunk', () => {
    const [hunk] = hunksOf('a\nb\nc\nd\ne\n', 'A\nb\nc\nd\nE\n');
    expect(hunkChangeRanges(hunk)).toEqual([
      { start: 1, end: 1 },
      { start: 5, end: 5 },
    ]);
  });

  it('handles a whole-file removal hunk', () => {
    const [hunk] = hunksOf('a\nb\n', '');
    expect(hunk.newCount).toBe(0);
    expect(hunkChangedRange(hunk)).toEqual({ start: 1, end: 1 });
  });
});

describe('range tracking across versions (integration)', () => {
  it('follows a range through unrelated edits back to its origin', () => {
    // v1 → v2 introduces the block; v2 → v3 edits above it; v3 → v4 edits it.
    const v1 = 'top\nbottom\n';
    const v2 = 'top\nblock-1\nblock-2\nbottom\n';
    const v3 = 'TOP\ntop2\nblock-1\nblock-2\nbottom\n';
    const v4 = 'TOP\ntop2\nblock-1 edited\nblock-2\nbottom\n';

    // Anchor: the block at v4 (lines 3..4).
    let range: LineRange | null = { start: 3, end: 4 };
    const touched: string[] = [];

    const pairs: [string, string, string][] = [
      ['v4', v3, v4],
      ['v3', v2, v3],
      ['v2', v1, v2],
    ];
    for (const [name, older, newer] of pairs) {
      const regions = regionsOf(older, newer);
      if (regions.some((region) => regionTouchesRange(region, range!))) touched.push(name);
      range = mapRangeToParent(regions, range!);
      if (!range) break;
    }

    // v3 only edited lines above the block — filtered out.
    expect(touched).toEqual(['v4', 'v2']);
    // The walk ended where the block was introduced.
    expect(range).toBeNull();
  });
});

describe('parseLineRange', () => {
  it('parses a single line', () => {
    expect(parseLineRange('18')).toEqual({ start: 18, end: 18 });
  });

  it('parses an inclusive span', () => {
    expect(parseLineRange('18-19')).toEqual({ start: 18, end: 19 });
  });

  it('rejects malformed, empty and inverted input', () => {
    expect(parseLineRange(undefined)).toBeNull();
    expect(parseLineRange('')).toBeNull();
    expect(parseLineRange('0')).toBeNull();
    expect(parseLineRange('abc')).toBeNull();
    expect(parseLineRange('19-18')).toBeNull();
    expect(parseLineRange('1-2-3')).toBeNull();
  });
});

describe('formatLineRange', () => {
  it('round-trips through parseLineRange', () => {
    for (const range of [
      { start: 1, end: 1 },
      { start: 18, end: 19 },
    ]) {
      expect(parseLineRange(formatLineRange(range))).toEqual(range);
    }
  });

  it('collapses a single-line range to one number', () => {
    expect(formatLineRange({ start: 7, end: 7 })).toBe('7');
    expect(formatLineRange({ start: 7, end: 9 })).toBe('7-9');
  });
});
