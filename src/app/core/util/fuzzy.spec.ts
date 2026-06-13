import { fuzzyMatch, fuzzyMatchPath, highlightSegments } from './fuzzy';

describe('fuzzyMatch', () => {
  it('matches a subsequence and reports its positions', () => {
    expect(fuzzyMatch('abc', 'aXbXc')?.positions).toEqual([0, 2, 4]);
  });

  it('is case-insensitive', () => {
    expect(fuzzyMatch('AB', 'a_b')?.positions).toEqual([0, 2]);
  });

  it('returns null when the query is not a subsequence', () => {
    expect(fuzzyMatch('abc', 'acb')).toBeNull();
    expect(fuzzyMatch('xyz', 'abc')).toBeNull();
  });

  it('returns a neutral match for an empty query', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] });
  });

  it('scores consecutive matches above scattered ones', () => {
    const consecutive = fuzzyMatch('ab', 'ab')!;
    const scattered = fuzzyMatch('ab', 'axb')!;
    expect(consecutive.score).toBeGreaterThan(scattered.score);
  });

  it('rewards matches on word boundaries', () => {
    const boundary = fuzzyMatch('rs', 'repo-store')!;
    expect(boundary.positions).toEqual([0, 5]); // r, and the s after "-"
    const inline = fuzzyMatch('rs', 'rxsy')!;
    expect(boundary.score).toBeGreaterThan(inline.score);
  });
});

describe('fuzzyMatchPath', () => {
  it('prefers a hit in the file name over one only in the directory', () => {
    const inName = fuzzyMatchPath('app', 'src/app.ts')!;
    const inDir = fuzzyMatchPath('app', 'app/src/main.ts')!;
    expect(inName.score).toBeGreaterThan(inDir.score);
  });

  it('reports name-match positions relative to the full path', () => {
    // "README" lands inside the basename of docs/README.md (offset 5).
    expect(fuzzyMatchPath('readme', 'docs/README.md')?.positions).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it('falls back to a (greedy) path match when the name does not match', () => {
    // No "core" in "main.ts", so it matches the path as a subsequence: the
    // greedy walk takes the first "c" (in "src") then "ore" from "core".
    const match = fuzzyMatchPath('core', 'src/core/main.ts')!;
    expect(match.positions).toEqual([2, 5, 6, 7]);
  });

  it('returns null when nothing matches', () => {
    expect(fuzzyMatchPath('zzz', 'src/app.ts')).toBeNull();
  });
});

describe('highlightSegments', () => {
  it('splits a string into matched and unmatched runs', () => {
    expect(highlightSegments('abcdef', [1, 2])).toEqual([
      { text: 'a', match: false },
      { text: 'bc', match: true },
      { text: 'def', match: false },
    ]);
  });

  it('treats a string with no positions as a single unmatched run', () => {
    expect(highlightSegments('abc', [])).toEqual([{ text: 'abc', match: false }]);
  });

  it('handles a match that reaches the end', () => {
    expect(highlightSegments('abc', [2])).toEqual([
      { text: 'ab', match: false },
      { text: 'c', match: true },
    ]);
  });
});
