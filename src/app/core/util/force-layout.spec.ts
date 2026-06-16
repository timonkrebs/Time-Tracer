import { ForceEdge, Point, forceLayout } from './force-layout';

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('forceLayout', () => {
  it('places every node and is deterministic for a given input', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const edges: ForceEdge[] = [
      { a: 'a', b: 'b' },
      { a: 'b', b: 'c' },
    ];
    const first = forceLayout(ids, edges);
    const second = forceLayout(ids, edges);

    expect([...first.keys()].sort()).toEqual(ids);
    expect([...first.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(
      true,
    );
    // Same input → byte-identical layout (no randomness, fixed iterations).
    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  it('pulls connected nodes together and pushes unconnected ones apart', () => {
    const pos = forceLayout(['a', 'b', 'c'], [{ a: 'a', b: 'b' }]);
    const ab = dist(pos.get('a')!, pos.get('b')!);
    const ac = dist(pos.get('a')!, pos.get('c')!);
    const bc = dist(pos.get('b')!, pos.get('c')!);
    // The a–b edge draws them together; the unconnected c is repelled away.
    expect(ab).toBeLessThan(ac);
    expect(ab).toBeLessThan(bc);
  });

  it('separates two clusters joined by nothing', () => {
    const pos = forceLayout(
      ['a', 'b', 'c', 'd'],
      [
        { a: 'a', b: 'b' },
        { a: 'c', b: 'd' },
      ],
    );
    const within = Math.max(dist(pos.get('a')!, pos.get('b')!), dist(pos.get('c')!, pos.get('d')!));
    const across = dist(pos.get('a')!, pos.get('c')!);
    // Each pair sits closer to itself than to the other cluster.
    expect(within).toBeLessThan(across);
  });

  it('settles a strong tie closer than a weak one', () => {
    const pos = forceLayout(
      ['hub', 'strong', 'weak'],
      [
        { a: 'hub', b: 'strong', weight: 1 },
        { a: 'hub', b: 'weak', weight: 0.1 },
      ],
    );
    expect(dist(pos.get('hub')!, pos.get('strong')!)).toBeLessThan(
      dist(pos.get('hub')!, pos.get('weak')!),
    );
  });

  it('handles the empty and single-node cases', () => {
    expect(forceLayout([], []).size).toBe(0);
    const one = forceLayout(['solo'], []);
    expect(one.get('solo')).toEqual({ x: 0, y: 0 });
  });
});
