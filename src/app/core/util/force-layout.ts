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

  // Deterministic seed: evenly spaced on a ring sized to the node count.
  const seedRadius = (k * Math.sqrt(n)) / 2;
  nodeIds.forEach((id, i) => {
    const angle = (2 * Math.PI * i) / n;
    pos.set(id, { x: seedRadius * Math.cos(angle), y: seedRadius * Math.sin(angle) });
  });

  // Keep only edges whose both endpoints are present.
  const present = new Set(nodeIds);
  const links = edges.filter((e) => present.has(e.a) && present.has(e.b));

  const disp = new Map<string, Point>();
  for (const id of nodeIds) disp.set(id, { x: 0, y: 0 });

  let temp = k * 2;
  const cooling = temp / (iterations + 1);

  for (let step = 0; step < iterations; step++) {
    for (const d of disp.values()) {
      d.x = 0;
      d.y = 0;
    }

    // Repulsion between every pair of nodes: k² / distance.
    for (let i = 0; i < n; i++) {
      const a = pos.get(nodeIds[i])!;
      const da = disp.get(nodeIds[i])!;
      for (let j = i + 1; j < n; j++) {
        const b = pos.get(nodeIds[j])!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          // Coincident nodes: nudge apart deterministically by index.
          dx = (i - j) * 0.01;
          dy = 0.01;
          dist = Math.hypot(dx, dy);
        }
        const force = (k * k) / dist / dist;
        const fx = dx * force;
        const fy = dy * force;
        da.x += fx;
        da.y += fy;
        const db = disp.get(nodeIds[j])!;
        db.x -= fx;
        db.y -= fy;
      }
    }

    // Attraction along edges: distance² / k, scaled by weight. Weight is honored
    // linearly, so a 0-weight tie exerts no pull at all (gravity still keeps the
    // node from drifting off); callers can fade a tie out completely.
    for (const link of links) {
      const a = pos.get(link.a)!;
      const b = pos.get(link.b)!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const force = (dist / k) * (link.weight ?? 1) * attraction;
      const fx = dx * force;
      const fy = dy * force;
      disp.get(link.a)!.x -= fx;
      disp.get(link.a)!.y -= fy;
      disp.get(link.b)!.x += fx;
      disp.get(link.b)!.y += fy;
    }

    // Gravity toward the centre, then a temperature-capped step.
    for (const id of nodeIds) {
      const p = pos.get(id)!;
      const d = disp.get(id)!;
      d.x -= p.x * gravity;
      d.y -= p.y * gravity;
      const len = Math.hypot(d.x, d.y) || 0.01;
      const stepLen = Math.min(len, temp);
      p.x += (d.x / len) * stepLen;
      p.y += (d.y / len) * stepLen;
    }
    temp = Math.max(temp - cooling, 0);
  }

  return pos;
}
