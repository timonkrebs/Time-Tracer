/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk) — lays weighted items
 * into a rectangle as tiles whose areas are proportional to their weight, kept
 * as close to square as possible.
 *
 * Pure and resolution-independent: callers pass a coordinate space (e.g. a
 * fixed SVG viewBox) and render the returned tiles however they like.
 */

export interface TreemapInput<T> {
  /** Relative area; non-positive items are dropped. */
  readonly weight: number;
  readonly value: T;
}

export interface TreemapTile<T> {
  readonly value: T;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Lays `items` into a `width`×`height` rectangle, largest first. */
export function squarify<T>(
  items: readonly TreemapInput<T>[],
  width: number,
  height: number,
): TreemapTile<T>[] {
  const tiles: TreemapTile<T>[] = [];
  const positive = items.filter((i) => i.weight > 0);
  const total = positive.reduce((sum, i) => sum + i.weight, 0);
  if (total <= 0 || width <= 0 || height <= 0) return tiles;

  // Scale weights so the total exactly fills the rectangle's area.
  const scale = (width * height) / total;
  const scaled = positive
    .map((i) => ({ area: i.weight * scale, value: i.value }))
    .sort((a, b) => b.area - a.area);

  // Remaining (not-yet-filled) sub-rectangle.
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;

  let i = 0;
  while (i < scaled.length) {
    const side = Math.min(w, h);
    const row: { area: number; value: T }[] = [];
    let rowAreas: number[] = [];

    // Grow the row while it keeps (or improves) the worst aspect ratio.
    while (i < scaled.length) {
      const candidate = [...rowAreas, scaled[i].area];
      if (row.length === 0 || worstRatio(candidate, side) <= worstRatio(rowAreas, side)) {
        row.push(scaled[i]);
        rowAreas = candidate;
        i++;
      } else {
        break;
      }
    }

    // Lay the row out along the shorter side, then shrink the remaining rect.
    const rowArea = rowAreas.reduce((sum, a) => sum + a, 0);
    const thickness = rowArea / side;
    if (w >= h) {
      let pos = y;
      for (const item of row) {
        const length = item.area / thickness;
        tiles.push({ value: item.value, x, y: pos, w: thickness, h: length });
        pos += length;
      }
      x += thickness;
      w -= thickness;
    } else {
      let pos = x;
      for (const item of row) {
        const length = item.area / thickness;
        tiles.push({ value: item.value, x: pos, y, w: length, h: thickness });
        pos += length;
      }
      y += thickness;
      h -= thickness;
    }
  }

  return tiles;
}

/** Worst (largest) aspect ratio among a row of areas laid along `side`. */
function worstRatio(areas: readonly number[], side: number): number {
  if (areas.length === 0) return Infinity;
  const sum = areas.reduce((s, a) => s + a, 0);
  let max = -Infinity;
  let min = Infinity;
  for (const a of areas) {
    if (a > max) max = a;
    if (a < min) min = a;
  }
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}
