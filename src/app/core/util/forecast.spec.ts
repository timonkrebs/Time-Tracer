import { computeForecast } from './forecast';

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);
const at = (days: number): string => new Date(T0 + days * DAY).toISOString();

describe('computeForecast', () => {
  it('flags files whose churn is accelerating in the recent half', () => {
    // Window spans 0…40 days → split at day 20. "rising" changed mostly after;
    // "cooling" mostly before; "steady" evenly.
    const forecast = computeForecast([
      { authoredAt: at(2), files: ['rising.ts'] },
      { authoredAt: at(30), files: ['rising.ts'] },
      { authoredAt: at(36), files: ['rising.ts'] },
      { authoredAt: at(40), files: ['rising.ts'] },
      { authoredAt: at(1), files: ['cooling.ts'] },
      { authoredAt: at(4), files: ['cooling.ts'] },
      { authoredAt: at(6), files: ['cooling.ts'] },
      { authoredAt: at(38), files: ['cooling.ts'] },
    ]);

    expect(forecast.from).toBe(T0 + 1 * DAY);
    expect(forecast.to).toBe(T0 + 40 * DAY);
    const rising = forecast.files.find((f) => f.path === 'rising.ts');
    expect(rising).toEqual({ path: 'rising.ts', recent: 3, prior: 1, acceleration: 2 });
    // cooling.ts has 1 recent vs 3 prior → negative acceleration → excluded.
    expect(forecast.files.some((f) => f.path === 'cooling.ts')).toBe(false);
  });

  it('requires at least `minRecent` recent commits', () => {
    const forecast = computeForecast([
      { authoredAt: at(0), files: ['a.ts'] },
      { authoredAt: at(40), files: ['a.ts'] }, // only 1 recent → below default minRecent 2
    ]);
    expect(forecast.files).toEqual([]);
  });

  it('drops sweeping commits and undated commits', () => {
    const huge = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
    const forecast = computeForecast(
      [
        { authoredAt: at(5), files: huge }, // > maxCommitFiles → ignored
        { authoredAt: 'nope', files: ['a.ts'] }, // undated → ignored
        { authoredAt: at(10), files: ['a.ts'] }, // window 10…40, split at 25
        { authoredAt: at(30), files: ['a.ts'] },
        { authoredAt: at(35), files: ['a.ts'] },
        { authoredAt: at(40), files: ['a.ts'] },
      ],
      { maxCommitFiles: 25 },
    );
    expect(forecast.files.map((f) => f.path)).toEqual(['a.ts']);
    expect(forecast.files[0].recent).toBe(3); // days 30/35/40
    expect(forecast.files[0].prior).toBe(1); // day 10
  });

  it('is empty when nothing qualifies', () => {
    expect(computeForecast([]).files).toEqual([]);
  });
});
