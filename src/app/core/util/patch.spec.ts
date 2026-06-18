import { applyPatch, parsePatch, patchStatsMatch } from './patch';

/** Apply a raw unified-diff patch to old lines (the way the survival walk does). */
function patched(oldLines: string[], patch: string): string[] | null {
  return applyPatch(oldLines, parsePatch(patch));
}

describe('parsePatch / applyPatch', () => {
  it('applies a single in-place modification', () => {
    const out = patched(['a', 'b', 'c'], ['@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'].join('\n'));
    expect(out).toEqual(['a', 'B', 'c']);
  });

  it('applies an insertion between context lines', () => {
    const out = patched(['a', 'b', 'c'], ['@@ -1,3 +1,4 @@', ' a', ' b', '+x', ' c'].join('\n'));
    expect(out).toEqual(['a', 'b', 'x', 'c']);
  });

  it('builds a brand-new file from an all-additions hunk', () => {
    const out = patched([], ['@@ -0,0 +1,2 @@', '+a', '+b'].join('\n'));
    expect(out).toEqual(['a', 'b']);
  });

  it('applies a deletion', () => {
    const out = patched(['a', 'b', 'c'], ['@@ -1,3 +1,2 @@', ' a', '-b', ' c'].join('\n'));
    expect(out).toEqual(['a', 'c']);
  });

  it('applies multiple hunks in one patch', () => {
    const out = patched(
      ['1', '2', '3', '4', '5', '6', '7', '8'],
      ['@@ -1,3 +1,3 @@', ' 1', '-2', '+X', ' 3', '@@ -6,3 +6,3 @@', ' 6', '-7', '+Y', ' 8'].join(
        '\n',
      ),
    );
    expect(out).toEqual(['1', 'X', '3', '4', '5', '6', 'Y', '8']);
  });

  it('ignores "\\ No newline at end of file" markers', () => {
    const out = patched(
      ['a', 'b'],
      ['@@ -1,2 +1,2 @@', ' a', '-b', '+B', '\\ No newline at end of file'].join('\n'),
    );
    expect(out).toEqual(['a', 'B']);
  });

  it('reads a hunk header that omits the line counts', () => {
    const out = patched(['a'], ['@@ -1 +1 @@', '-a', '+b'].join('\n'));
    expect(out).toEqual(['b']);
  });

  it('returns null when context does not match (stale snapshot → fall back to the blob)', () => {
    const out = patched(['a', 'b', 'c'], ['@@ -1,3 +1,3 @@', ' a', '-X', '+Y', ' c'].join('\n'));
    expect(out).toBeNull();
  });

  it('returns null for an out-of-range hunk', () => {
    const out = patched(['a'], ['@@ -5,1 +5,1 @@', '-a', '+b'].join('\n'));
    expect(out).toBeNull();
  });

  it('returns null when a hunk body does not match its header counts (truncated patch)', () => {
    // Header promises 5 old lines but the body only describes 2 — a truncated
    // hunk whose prefix matches must not be accepted.
    const out = patched(['a', 'b', 'c', 'd', 'e'], ['@@ -1,5 +1,5 @@', ' a', '-b'].join('\n'));
    expect(out).toBeNull();
  });
});

describe('patchStatsMatch', () => {
  const hunks = parsePatch(['@@ -1,2 +1,2 @@', ' a', '-b', '+B'].join('\n')); // 1 add, 1 del

  it('accepts a patch whose totals match the provider stats', () => {
    expect(patchStatsMatch(hunks, { additions: 1, deletions: 1 })).toBe(true);
  });

  it('rejects a patch whose totals fall short (truncated between hunks)', () => {
    expect(patchStatsMatch(hunks, { additions: 5, deletions: 1 })).toBe(false);
    expect(patchStatsMatch(hunks, { additions: 1, deletions: 3 })).toBe(false);
  });

  it('does not check stats the provider did not supply', () => {
    expect(patchStatsMatch(hunks, {})).toBe(true);
  });
});
