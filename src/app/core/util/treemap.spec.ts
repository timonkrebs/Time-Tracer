import { TreemapInput, squarify } from './treemap';

function items(weights: number[]): TreemapInput<number>[] {
  return weights.map((weight, value) => ({ weight, value }));
}

describe('squarify', () => {
  it('returns one tile per positive item, filling the rectangle', () => {
    const tiles = squarify(items([6, 6, 4, 3, 2, 1]), 600, 400);
    expect(tiles).toHaveLength(6);

    const area = tiles.reduce((sum, t) => sum + t.w * t.h, 0);
    expect(area).toBeCloseTo(600 * 400, 3);

    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(-1e-6);
      expect(t.y).toBeGreaterThanOrEqual(-1e-6);
      expect(t.x + t.w).toBeLessThanOrEqual(600 + 1e-6);
      expect(t.y + t.h).toBeLessThanOrEqual(400 + 1e-6);
    }
  });

  it('makes tile area proportional to weight', () => {
    const tiles = squarify(items([8, 4, 2, 2]), 100, 100);
    const areaOf = (value: number) => {
      const t = tiles.find((tile) => tile.value === value)!;
      return t.w * t.h;
    };
    // Item 0 (weight 8) covers half the total weight of 16 → half the area.
    expect(areaOf(0)).toBeCloseTo(0.5 * 100 * 100, 3);
    expect(areaOf(0)).toBeCloseTo(2 * areaOf(1), 3);
    expect(areaOf(1)).toBeCloseTo(2 * areaOf(2), 3);
  });

  it('drops non-positive weights and handles empty / zero input', () => {
    expect(squarify(items([5, 0, -3, 5]), 100, 100)).toHaveLength(2);
    expect(squarify(items([]), 100, 100)).toEqual([]);
    expect(squarify(items([1, 2]), 0, 100)).toEqual([]);
  });
});
