import { CommitInfo } from '../models';
import { computeFileMetric, heatLevel } from './hotspots';

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
});
