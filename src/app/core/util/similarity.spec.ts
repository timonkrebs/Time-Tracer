import { lineSimilarity } from './diff';
import { findBlockOrigin, fuzzyLineSimilarity, levenshteinSimilarity } from './similarity';

describe('levenshteinSimilarity', () => {
  it('scores identical strings 1 and disjoint strings near 0', () => {
    expect(levenshteinSimilarity('rocket', 'rocket')).toBe(1);
    expect(levenshteinSimilarity('abc', 'xyz')).toBe(0);
    expect(levenshteinSimilarity('', 'abc')).toBe(0);
    expect(levenshteinSimilarity('', '')).toBe(1);
  });

  it('normalizes the classic kitten/sitting distance', () => {
    // Distance 3 over max length 7.
    expect(levenshteinSimilarity('kitten', 'sitting')).toBeCloseTo(4 / 7, 10);
    expect(levenshteinSimilarity('sitting', 'kitten')).toBeCloseTo(4 / 7, 10);
  });

  it('rates a small edit of a typical code line highly', () => {
    const a = 'const thrust = engine.power * throttle;';
    const b = 'const thrust = engine.power * throttle * 2;';
    expect(levenshteinSimilarity(a, b)).toBeGreaterThan(0.85);
  });

  it('falls back to bigram similarity for very long lines', () => {
    const a = 'ab'.repeat(300);
    const b = 'ab'.repeat(300) + 'zz';
    expect(levenshteinSimilarity(a, b)).toBeGreaterThan(0.9);
    expect(levenshteinSimilarity(a, 'qx'.repeat(300))).toBeLessThan(0.1);
  });
});

describe('fuzzyLineSimilarity', () => {
  it('keeps the exact-line behaviour at the extremes', () => {
    expect(fuzzyLineSimilarity('a\nb\n', 'a\nb\n')).toBe(1);
    expect(fuzzyLineSimilarity('', '')).toBe(1);
    expect(fuzzyLineSimilarity('alpha\nbeta\n', '')).toBe(0);
    expect(fuzzyLineSimilarity('aaaa\nbbbb\n', 'cccc\ndddd\n')).toBe(0);
  });

  it('credits edited lines that exact-line similarity ignores', () => {
    // A "rename + touch up": every second line got a small edit.
    const before = [
      'export class Thruster {',
      '  private readonly power = 42;',
      '  ignite(): void {',
      '    this.burn(this.power);',
      '  }',
      '}',
    ].join('\n');
    const after = [
      'export class Engine {',
      '  private readonly power = 42;',
      '  ignite(): void {',
      '    this.burnFuel(this.power);',
      '  }',
      '}',
    ].join('\n');

    const exact = lineSimilarity(before, after);
    const fuzzy = fuzzyLineSimilarity(before, after);
    expect(fuzzy).toBeGreaterThan(exact);
    expect(fuzzy).toBeGreaterThan(0.85);
  });

  it('does not credit unrelated replacement lines', () => {
    const before = 'const a = computeOrbit(x);\n';
    const after = 'import { z } from "./z";\n';
    expect(fuzzyLineSimilarity(before, after)).toBe(0);
  });
});

describe('findBlockOrigin', () => {
  const file = [
    'import { fuel } from "./fuel";',
    '',
    'export function ignite(): void {',
    '  const mix = fuel.mix(0.8);',
    '  chamber.fill(mix);',
    '  spark();',
    '}',
    '',
    'export function vent(): void {',
    '  chamber.drain();',
    '}',
  ];

  it('finds an exactly moved block and reports its position', () => {
    const block = ['  const mix = fuel.mix(0.8);', '  chamber.fill(mix);', '  spark();'];
    expect(findBlockOrigin(block, file)).toEqual({ line: 4, score: 1 });
  });

  it('matches a block whose lines were edited during the move', () => {
    const block = ['  const mix = fuel.mix(0.9);', '  chamber.fill(mix);', '  sparkTwice();'];
    const match = findBlockOrigin(block, file);
    expect(match?.line).toBe(4);
    expect(match!.score).toBeGreaterThan(0.6);
    expect(match!.score).toBeLessThan(1);
  });

  it('tolerates a line inserted inside the moved block', () => {
    // The file has an extra line between the block's lines.
    const block = ['  const mix = fuel.mix(0.8);', '  spark();'];
    expect(findBlockOrigin(block, file)).toEqual({ line: 4, score: 1 });
  });

  it('ignores trivial lines when weighting the score', () => {
    const block = ['}', '  chamber.drain();', '}'];
    // The only significant line matches exactly: full confidence.
    expect(findBlockOrigin(block, file)).toMatchObject({ score: 1 });
  });

  it('needs at least one exact anchor line', () => {
    // Similar-but-never-identical lines must not produce an origin.
    const block = ['  const mix = fuel.mix(0.81);', '  chamber.fill(mixx);'];
    expect(findBlockOrigin(block, file)).toBeNull();
  });

  it('anchors on trivial lines only when the whole block is trivial', () => {
    const trivial = ['', 'Go!'];
    expect(findBlockOrigin(trivial, ['hello', '', 'Go!'])).toEqual({ line: 2, score: 1 });
    // A block with significant lines must not anchor on its braces alone.
    const mixed = ['}', '  launchSequence(now);'];
    expect(findBlockOrigin(mixed, file)).toBeNull();
  });

  it('returns null when nothing matches or inputs are empty', () => {
    expect(findBlockOrigin(['nothing like this'], file)).toBeNull();
    expect(findBlockOrigin([], file)).toBeNull();
    expect(findBlockOrigin(['x'], [])).toBeNull();
  });
});
