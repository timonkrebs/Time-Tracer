import { CommitInfo } from '../models';
import {
  HEAT_THRESHOLDS,
  HotspotCommit,
  computeFileMetric,
  computeHotspots,
  heatLevel,
} from './hotspots';

const DAY_MS = 86_400_000;

function commit(authoredAt: string, authorName = 'Ada'): CommitInfo {
  return {
    sha: `sha-${authoredAt}-${authorName}`,
    message: 'msg',
    summary: 'msg',
    authorName,
    authorEmail: null,
    authoredAt,
    htmlUrl: '',
    parentShas: [],
  };
}

/** A fixed "now" so age-based weighting is deterministic. */
const NOW = Date.parse('2026-06-13T00:00:00Z');
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY_MS).toISOString();

describe('computeFileMetric', () => {
  it('counts revisions and distinct authors', () => {
    const metric = computeFileMetric(
      [commit(iso(1), 'Ada'), commit(iso(2), 'Ada'), commit(iso(3), 'Linus')],
      { now: NOW },
    );
    expect(metric.revisions).toBe(3);
    expect(metric.authors).toBe(2);
  });

  it('weights a commit made today at ~1 and one a half-life old at ~0.5', () => {
    const today = computeFileMetric([commit(iso(0))], { now: NOW, halfLifeDays: 90 });
    expect(today.score).toBeCloseTo(1, 5);

    const halfLifeOld = computeFileMetric([commit(iso(90))], { now: NOW, halfLifeDays: 90 });
    expect(halfLifeOld.score).toBeCloseTo(0.5, 5);
  });

  it('ranks a recently-churned file above an old one with the same revision count', () => {
    const recent = computeFileMetric([commit(iso(1)), commit(iso(2)), commit(iso(3))], {
      now: NOW,
    });
    const old = computeFileMetric([commit(iso(400)), commit(iso(401)), commit(iso(402))], {
      now: NOW,
    });
    expect(recent.revisions).toBe(old.revisions);
    expect(recent.score).toBeGreaterThan(old.score);
  });

  it('tracks the newest and oldest commit dates', () => {
    const metric = computeFileMetric([commit(iso(2)), commit(iso(10)), commit(iso(5))], {
      now: NOW,
    });
    expect(metric.lastChange).toBe(iso(2));
    expect(metric.firstChange).toBe(iso(10));
  });

  it('clamps future-dated commits (clock skew) to weight 1', () => {
    const metric = computeFileMetric([commit(iso(-30))], { now: NOW, halfLifeDays: 90 });
    expect(metric.score).toBeCloseTo(1, 5);
  });

  it('counts commits with an unparseable date as revisions but not toward the score', () => {
    const metric = computeFileMetric([commit(''), commit(iso(0))], { now: NOW });
    expect(metric.revisions).toBe(2);
    expect(metric.score).toBeCloseTo(1, 5);
    expect(metric.lastChange).toBe(iso(0));
  });

  it('reports partial when flagged and defaults it to false', () => {
    expect(computeFileMetric([commit(iso(0))], { now: NOW }).partial).toBe(false);
    expect(computeFileMetric([commit(iso(0))], { now: NOW, partial: true }).partial).toBe(true);
  });

  it('handles an empty history', () => {
    const metric = computeFileMetric([], { now: NOW });
    expect(metric).toMatchObject({
      revisions: 0,
      score: 0,
      lastChange: null,
      firstChange: null,
      authors: 0,
    });
  });
});

describe('heatLevel', () => {
  it('maps scores onto cold→hot buckets', () => {
    expect(heatLevel(0)).toBe(0);
    expect(heatLevel(0.5)).toBe(0);
    expect(heatLevel(1)).toBe(1);
    expect(heatLevel(2)).toBe(2);
    expect(heatLevel(5)).toBe(3);
    expect(heatLevel(12)).toBe(4);
  });

  it('changes band exactly at each HEAT_THRESHOLDS boundary', () => {
    HEAT_THRESHOLDS.forEach((threshold, level) => {
      expect(heatLevel(threshold)).toBe(level);
      if (level > 0) expect(heatLevel(threshold - 0.001)).toBe(level - 1);
    });
  });
});

describe('computeHotspots', () => {
  const now = Date.parse('2026-06-14T00:00:00Z');
  function hc(authoredAt: string, files: string[]): HotspotCommit {
    return { authorName: 'Ada', authoredAt, files };
  }

  it('ranks files by recency-weighted churn and attaches sizes', () => {
    const commits: HotspotCommit[] = [
      hc('2026-06-13T00:00:00Z', ['hot.ts', 'a.ts']),
      hc('2026-06-12T00:00:00Z', ['hot.ts']),
      hc('2026-06-10T00:00:00Z', ['hot.ts']),
      hc('2020-01-01T00:00:00Z', ['cold.ts']), // ancient → low score
    ];
    const sizes = new Map([
      ['hot.ts', 1000],
      ['a.ts', 50],
      ['cold.ts', 200],
    ]);

    const hotspots = computeHotspots(commits, sizes, { now });

    expect(hotspots[0].path).toBe('hot.ts');
    expect(hotspots[0].metric.revisions).toBe(3);
    expect(hotspots[0].size).toBe(1000);
    // The ancient file scores below the recent ones.
    const cold = hotspots.find((h) => h.path === 'cold.ts')!;
    expect(cold.metric.score).toBeLessThan(hotspots[0].metric.score);
  });

  it('skips commits that touch more files than the cap', () => {
    const commits: HotspotCommit[] = [
      hc('2026-06-13T00:00:00Z', ['x.ts', 'y.ts', 'z.ts']), // a sweep
      hc('2026-06-12T00:00:00Z', ['x.ts']),
    ];
    const hotspots = computeHotspots(commits, new Map(), { now, maxCommitFiles: 2 });
    // Only the second commit counts; x.ts has one revision, y/z none.
    expect(hotspots).toHaveLength(1);
    expect(hotspots[0]).toMatchObject({ path: 'x.ts', size: 0 });
    expect(hotspots[0].metric.revisions).toBe(1);
  });
});
