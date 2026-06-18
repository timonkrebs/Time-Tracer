import {
  CODE_HALF_LIFE_BENCHMARK,
  LineLifetime,
  authorShares,
  cohortSeries,
  kaplanMeier,
  summarizeSurvival,
  survivalAt,
} from './survival';

const DAY = 86_400_000;
const NOW = 100 * DAY;

/** A line that dies `diedAge` days after birth (birth pinned so the age is exact). */
function death(diedAge: number, author = 'Ada'): LineLifetime {
  return { bornAt: 0, diedAt: diedAge * DAY, author };
}
/** A line still alive at NOW, `age` days old. */
function alive(age: number, author = 'Ada'): LineLifetime {
  return { bornAt: NOW - age * DAY, diedAt: null, author };
}

describe('kaplanMeier', () => {
  it('estimates the product-limit survival curve with censoring', () => {
    // Ages: 2†, 3†, 4 (censored), 5†, 6 (censored).
    const curve = kaplanMeier([death(2), death(3), alive(4), death(5), alive(6)], NOW);

    expect(curve.totalLines).toBe(5);
    expect(curve.deaths).toBe(3);
    expect(curve.censored).toBe(2);
    expect(curve.maxObservedAgeDays).toBe(6); // the oldest line (a censored survivor) is 6 days old

    // S steps only at death ages; censored lines just leave the risk set.
    //   age 2: 1/5 die → 0.8 · age 3: 1/4 → 0.6 · age 5: 1/2 → 0.3
    expect(curve.points.map((p) => [p.ageDays, p.atRisk, p.deaths])).toEqual([
      [0, 5, 0],
      [2, 5, 1],
      [3, 4, 1],
      [5, 2, 1],
    ]);
    curve.points.forEach((p, i) => expect(p.survival).toBeCloseTo([1, 0.8, 0.6, 0.3][i], 10));
  });

  it('reads the code half-life off the curve as the median lifetime', () => {
    const curve = kaplanMeier([death(2), death(3), alive(4), death(5), alive(6)], NOW);
    // S first reaches ≤ ½ at age 5 (drops 0.6 → 0.3).
    expect(curve.halfLifeDays).toBe(5);
    expect(survivalAt(curve, 4)).toBeCloseTo(0.6, 10);
    expect(survivalAt(curve, 5)).toBeCloseTo(0.3, 10);
    expect(survivalAt(curve, 50)).toBeCloseTo(0.3, 10); // flat after the last step
  });

  it('does not collapse under survivorship bias when nothing has died', () => {
    // A snapshot of survivors alone must read as S(t) = 1, not decay.
    const curve = kaplanMeier([alive(1), alive(5), alive(10)], NOW);
    expect(curve.deaths).toBe(0);
    expect(curve.censored).toBe(3);
    expect(curve.points).toEqual([{ ageDays: 0, survival: 1, atRisk: 3, deaths: 0 }]);
    expect(curve.halfLifeDays).toBeNull();
    expect(survivalAt(curve, 9999)).toBe(1);
  });

  it('handles an empty population', () => {
    const curve = kaplanMeier([], NOW);
    expect(curve.points).toEqual([{ ageDays: 0, survival: 1, atRisk: 0, deaths: 0 }]);
    expect(curve.halfLifeDays).toBeNull();
  });
});

describe('cohortSeries', () => {
  const y = (year: number): number => Date.UTC(year, 0, 1);
  const tip = Date.UTC(2026, 0, 1);

  it('counts surviving lines per birth-year cohort over time', () => {
    const lines: LineLifetime[] = [
      { bornAt: y(2020), diedAt: null, author: 'Ada' },
      { bornAt: y(2020), diedAt: null, author: 'Ada' },
      { bornAt: y(2020), diedAt: null, author: 'Bob' },
      { bornAt: y(2024), diedAt: null, author: 'Bob' },
      { bornAt: y(2024), diedAt: y(2025), author: 'Bob' }, // born 2024, dead before the tip
    ];
    const stack = cohortSeries(lines, { now: tip, samples: 24 });

    expect(stack.bands).toEqual(['2020', '2024']);
    const last = stack.times.length - 1;
    // At the tip: all three 2020 lines survive; one of the two 2024 lines does.
    expect(stack.counts.get('2020')![last]).toBe(3);
    expect(stack.counts.get('2024')![last]).toBe(1);
    // At the start (2020) no 2024 line exists yet.
    expect(stack.counts.get('2024')![0]).toBe(0);
  });

  it('folds the oldest years into one band beyond the cap', () => {
    const lines: LineLifetime[] = [];
    for (let year = 2015; year <= 2024; year++)
      lines.push({ bornAt: y(year), diedAt: null, author: 'Ada' });
    const stack = cohortSeries(lines, { now: tip, maxBands: 3 });
    // Newest two years kept; everything older folded into one ≤2022 band.
    expect(stack.bands).toEqual(['≤2022', '2023', '2024']);
  });

  it('buckets cohorts by calendar month', () => {
    const at = (year: number, month: number): number => Date.UTC(year, month - 1, 15);
    const lines: LineLifetime[] = [
      { bornAt: at(2024, 1), diedAt: null, author: 'Ada' },
      { bornAt: at(2024, 1), diedAt: null, author: 'Ada' },
      { bornAt: at(2024, 3), diedAt: null, author: 'Bob' },
    ];
    const stack = cohortSeries(lines, { now: Date.UTC(2024, 5, 1), bucket: 'month', samples: 12 });

    expect(stack.bands).toEqual(['2024-01', '2024-03']);
    const last = stack.times.length - 1;
    expect(stack.counts.get('2024-01')![last]).toBe(2);
    expect(stack.counts.get('2024-03')![last]).toBe(1);
  });

  it('buckets cohorts by week, labelled by the week-start (Monday) date', () => {
    // 2024-03-04 is a Monday; the 6th is the same week, the 11th the next Monday.
    const lines: LineLifetime[] = [
      { bornAt: Date.UTC(2024, 2, 4), diedAt: null, author: 'Ada' },
      { bornAt: Date.UTC(2024, 2, 6), diedAt: null, author: 'Ada' },
      { bornAt: Date.UTC(2024, 2, 11), diedAt: null, author: 'Bob' },
    ];
    const stack = cohortSeries(lines, { now: Date.UTC(2024, 2, 20), bucket: 'week', samples: 12 });

    expect(stack.bands).toEqual(['2024-03-04', '2024-03-11']);
    const last = stack.times.length - 1;
    expect(stack.counts.get('2024-03-04')![last]).toBe(2);
    expect(stack.counts.get('2024-03-11')![last]).toBe(1);
  });

  it('returns nothing for an empty population', () => {
    expect(cohortSeries([], { now: tip })).toEqual({ bands: [], times: [], counts: new Map() });
  });
});

describe('authorShares', () => {
  it('ranks authors by their share of the code alive today', () => {
    const lines: LineLifetime[] = [
      { bornAt: 0, diedAt: null, author: 'Ada' },
      { bornAt: 0, diedAt: null, author: 'Ada' },
      { bornAt: 0, diedAt: null, author: 'Ada' },
      { bornAt: 0, diedAt: null, author: 'Bob' },
      { bornAt: 0, diedAt: 5 * DAY, author: 'Bob' }, // dead → not part of "the code"
    ];
    const shares = authorShares(lines);
    expect(shares).toEqual([
      { author: 'Ada', lines: 3, share: 0.75 },
      { author: 'Bob', lines: 1, share: 0.25 },
    ]);
  });

  it('folds the tail into "Others" past the limit', () => {
    const lines: LineLifetime[] = [
      { bornAt: 0, diedAt: null, author: 'Ada' },
      { bornAt: 0, diedAt: null, author: 'Ada' },
      { bornAt: 0, diedAt: null, author: 'Bob' },
      { bornAt: 0, diedAt: null, author: 'Cy' },
    ];
    const shares = authorShares(lines, { limit: 2 });
    expect(shares.map((s) => s.author)).toEqual(['Ada', 'Others']);
    expect(shares[1].lines).toBe(2); // Bob + Cy
  });
});

describe('censored-early lifetimes (a line that became unobservable)', () => {
  it('counts them, but not as deaths or live code, and censors them at censoredAt', () => {
    const lines: LineLifetime[] = [
      { bornAt: 0, diedAt: 2 * DAY, author: 'Ada' }, // dies at age 2
      { bornAt: 0, diedAt: null, censoredAt: 4 * DAY, author: 'Bob' }, // last seen alive at age 4
    ];
    const report = summarizeSurvival(lines, { now: NOW });

    expect(report.trackedLines).toBe(2); // both observed, neither dropped
    expect(report.aliveLines).toBe(0); // neither confirmed in the current tree
    expect(report.curve.deaths).toBe(1);
    expect(report.curve.censored).toBe(1); // the unobservable line is censored, not dead
    expect(report.curve.maxObservedAgeDays).toBe(4); // observed out to its censoring age
    expect(report.authors).toEqual([]); // no live code → no author shares
  });
});

describe('summarizeSurvival', () => {
  it('rolls the three analyses up from one lifetime table', () => {
    const report = summarizeSurvival([death(4), alive(2, 'Bob'), alive(8)], { now: NOW });
    expect(report.trackedLines).toBe(3);
    expect(report.aliveLines).toBe(2);
    expect(report.curve.deaths).toBe(1);
    expect(report.authors.map((a) => a.author)).toEqual(['Ada', 'Bob']);
  });

  it('is empty for no lifetimes', () => {
    const report = summarizeSurvival([], { now: NOW });
    expect(report.aliveLines).toBe(0);
    expect(report.authors).toEqual([]);
    expect(report.cohorts.bands).toEqual([]);
  });
});

describe('CODE_HALF_LIFE_BENCHMARK', () => {
  it('pins Bernhardsson’s reference figures', () => {
    expect(CODE_HALF_LIFE_BENCHMARK.halfLifeYears).toBe(6);
    expect(CODE_HALF_LIFE_BENCHMARK.survivalAtTenYears).toBe(0.4);
    expect(CODE_HALF_LIFE_BENCHMARK.points.at(-1)).toEqual({ years: 10, survival: 0.4 });
  });
});
