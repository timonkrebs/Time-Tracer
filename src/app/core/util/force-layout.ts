/**
 * A small, deterministic force-directed graph layout (Fruchterman–Reingold).
 *
 * Given node ids and weighted edges, it returns a position per node by
 * simulating repulsion between every pair of nodes and attraction along edges,
 * cooled over a fixed number of iterations. It is **deterministic** — nodes are
 * seeded on a ring by their given order and no randomness is used — so the same
 * input always produces the same layout (stable across redraws and easy to
 * test). Connected nodes settle close together and unconnected ones drift
 * apart, so clusters and the people bridging them become visible.
 *
 * Coordinates are arbitrary and centred near the origin; callers scale and
 * translate the result into their own viewport.
 */

/** A weighted, undirected edge between two node ids. */
export interface ForceEdge {
  readonly a: string;
  readonly b: string;
  /** Relative pull (~0..1, default 1) — stronger edges settle closer; 0 = no pull. */
  readonly weight?: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ForceLayoutOptions {
  /** Simulation steps; more is steadier but costlier. */
  readonly iterations?: number;
  /** Ideal edge length — sets the coordinate scale (callers refit anyway). */
  readonly spread?: number;
  /** Pull toward the centre each step, so disconnected parts don't drift off. */
  readonly gravity?: number;
  /**
   * Edge pull multiplier (default 1). Below 1 settles connected nodes farther
   * apart *relative to the whole graph*, loosening tight clusters so their
   * labels stay legible after the result is scaled to fit.
   */
  readonly attraction?: number;
}

const DEFAULT_ITERATIONS = 300;
const DEFAULT_SPREAD = 160;
const DEFAULT_GRAVITY = 0.03;
const DEFAULT_ATTRACTION = 1;

/** Computes a position for every node id. Deterministic for a given input. */
export function forceLayout(
  nodeIds: readonly string[],
  edges: readonly ForceEdge[],
  options: ForceLayoutOptions = {},
): Map<string, Point> {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const k = options.spread ?? DEFAULT_SPREAD;
  const gravity = options.gravity ?? DEFAULT_GRAVITY;
  const attraction = options.attraction ?? DEFAULT_ATTRACTION;

  const n = nodeIds.length;
  const pos = new Map<string, Point>();
  if (n === 0) return pos;
  if (n === 1) {
    pos.set(nodeIds[0], { x: 0, y: 0 });
    return pos;
  }

  // The simulation runs on flat typed arrays indexed by node position — the
  // O(iterations · n²) repulsion loop is the whole cost of this function, and
  // per-pair Map lookups there dominate the arithmetic. Ids map to indexes
  // once, coordinates live in x/y arrays, and edges are resolved to index
  // pairs up front.
  const indexOf = new Map<string, number>();
  nodeIds.forEach((id, i) => indexOf.set(id, i));

  const x = new Float64Array(n);
  const y = new Float64Array(n);
  // Deterministic seed: evenly spaced on a ring sized to the node count.
  const seedRadius = (k * Math.sqrt(n)) / 2;
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n;
    x[i] = seedRadius * Math.cos(angle);
    y[i] = seedRadius * Math.sin(angle);
  }

  // Keep only edges whose both endpoints are present.
  const linkA: number[] = [];
  const linkB: number[] = [];
  const linkW: number[] = [];
  for (const e of edges) {
    const a = indexOf.get(e.a);
    const b = indexOf.get(e.b);
    if (a === undefined || b === undefined) continue;
    linkA.push(a);
    linkB.push(b);
    linkW.push((e.weight ?? 1) * attraction);
  }
  const linkCount = linkA.length;

  const dispX = new Float64Array(n);
  const dispY = new Float64Array(n);

  let temp = k * 2;
  const cooling = temp / (iterations + 1);
  const k2 = k * k;

  for (let step = 0; step < iterations; step++) {
    dispX.fill(0);
    dispY.fill(0);

    // Repulsion between every pair of nodes: k² / distance.
    for (let i = 0; i < n; i++) {
      const xi = x[i];
      const yi = y[i];
      let dxAcc = 0;
      let dyAcc = 0;
      for (let j = i + 1; j < n; j++) {
        let dx = xi - x[j];
        let dy = yi - y[j];
        let distSq = dx * dx + dy * dy;
        if (distSq < 0.0001) {
          // Coincident nodes: nudge apart deterministically by index.
          dx = (i - j) * 0.01;
          dy = 0.01;
          distSq = dx * dx + dy * dy;
        }
        const force = k2 / distSq;
        const fx = dx * force;
        const fy = dy * force;
        dxAcc += fx;
        dyAcc += fy;
        dispX[j] -= fx;
        dispY[j] -= fy;
      }
      dispX[i] += dxAcc;
      dispY[i] += dyAcc;
    }

    // Attraction along edges: distance² / k, scaled by weight. Weight is honored
    // linearly, so a 0-weight tie exerts no pull at all (gravity still keeps the
    // node from drifting off); callers can fade a tie out completely.
    for (let e = 0; e < linkCount; e++) {
      const a = linkA[e];
      const b = linkB[e];
      const dx = x[a] - x[b];
      const dy = y[a] - y[b];
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (dist / k) * linkW[e];
      const fx = dx * force;
      const fy = dy * force;
      dispX[a] -= fx;
      dispY[a] -= fy;
      dispX[b] += fx;
      dispY[b] += fy;
    }

    // Gravity toward the centre, then a temperature-capped step.
    for (let i = 0; i < n; i++) {
      const dx = dispX[i] - x[i] * gravity;
      const dy = dispY[i] - y[i] * gravity;
      const len = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const stepLen = Math.min(len, temp);
      x[i] += (dx / len) * stepLen;
      y[i] += (dy / len) * stepLen;
    }
    temp = Math.max(temp - cooling, 0);
  }

  for (let i = 0; i < n; i++) pos.set(nodeIds[i], { x: x[i], y: y[i] });
  return pos;
}
