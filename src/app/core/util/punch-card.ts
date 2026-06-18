/**
 * Commit "punch card": a day-of-week × hour-of-day histogram of commit
 * timestamps, the classic GitHub-style view of when work happens. Pure and
 * deterministic so it stays decoupled from the store.
 *
 * Times are read at their **recorded wall-clock** — the local time as written
 * in the timestamp (its own UTC offset where the provider preserves one),
 * rather than converted to the viewer's timezone — so the card reflects when
 * the authors were actually working. Strings without a parseable time are
 * skipped.
 */

/** A 7×24 commit histogram plus its marginals. */
export interface PunchCard {
  /** `grid[day][hour]` counts; day 0 = Sunday … 6 = Saturday, hour 0…23. */
  readonly grid: readonly (readonly number[])[];
  /** Total commits counted. */
  readonly total: number;
  /** Busiest single cell's count (0 when empty) — the colour-scale top. */
  readonly max: number;
  /** Commits per weekday (index 0 = Sunday). */
  readonly byDay: readonly number[];
  /** Commits per hour (index 0 = midnight). */
  readonly byHour: readonly number[];
}

/** Weekday + hour (and year) of an ISO timestamp's own wall-clock, or null. */
export function wallClockParts(iso: string): { year: number; day: number; hour: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):/.exec(iso);
  if (!match) return null;
  const [, year, month, dayOfMonth, hour] = match;
  // Weekday of the written calendar date (computed in UTC so it isn't shifted
  // by the runtime's timezone).
  const day = new Date(Date.UTC(+year, +month - 1, +dayOfMonth)).getUTCDay();
  if (Number.isNaN(day)) return null;
  return { year: +year, day, hour: +hour };
}

/** Bins commit timestamps into a {@link PunchCard}. */
export function punchCard(times: Iterable<string>): PunchCard {
  const grid: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const byDay = new Array<number>(7).fill(0);
  const byHour = new Array<number>(24).fill(0);
  let total = 0;
  let max = 0;

  for (const iso of times) {
    const parts = wallClockParts(iso);
    if (!parts) continue;
    const count = ++grid[parts.day][parts.hour];
    byDay[parts.day]++;
    byHour[parts.hour]++;
    total++;
    if (count > max) max = count;
  }

  return { grid, total, max, byDay, byHour };
}

/** Headline work-rhythm patterns drawn from a day×hour {@link PunchCard}. */
export interface PunchInsights {
  readonly hasData: boolean;
  /** The busiest cell. */
  readonly peakDay: number;
  readonly peakHour: number;
  readonly peakCount: number;
  /** Share of commits outside 09:00–17:00, any day (0..1). */
  readonly afterHoursShare: number;
  /** Share of commits on Saturday or Sunday (0..1). */
  readonly weekendShare: number;
  /** Earliest and latest hour with any commits. */
  readonly firstActiveHour: number;
  readonly lastActiveHour: number;
}

/** "9–5" business hours: 09:00 up to (not including) 17:00. */
const BUSINESS_START = 9;
const BUSINESS_END = 17;

/** Derives the headline patterns shown above the punch card. */
export function punchInsights(card: PunchCard): PunchInsights {
  let peakDay = 0;
  let peakHour = 0;
  let peakCount = 0;
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      if (card.grid[day][hour] > peakCount) {
        peakCount = card.grid[day][hour];
        peakDay = day;
        peakHour = hour;
      }
    }
  }

  let business = 0;
  let firstActiveHour = 0;
  let lastActiveHour = 0;
  let seen = false;
  for (let hour = 0; hour < 24; hour++) {
    if (hour >= BUSINESS_START && hour < BUSINESS_END) business += card.byHour[hour];
    if (card.byHour[hour] > 0) {
      if (!seen) {
        firstActiveHour = hour;
        seen = true;
      }
      lastActiveHour = hour;
    }
  }

  const total = card.total;
  const weekend = card.byDay[0] + card.byDay[6];
  return {
    hasData: total > 0,
    peakDay,
    peakHour,
    peakCount,
    afterHoursShare: total > 0 ? (total - business) / total : 0,
    weekendShare: total > 0 ? weekend / total : 0,
    firstActiveHour,
    lastActiveHour,
  };
}

/** A year × weekday commit histogram — the punch card's coarser companion. */
export interface YearWeekdayCard {
  /** Calendar years present, newest first. */
  readonly years: readonly number[];
  /** `grid[yearIndex][weekday]` counts; weekday 0 = Sunday … 6 = Saturday. */
  readonly grid: readonly (readonly number[])[];
  /** Commits per year, aligned with {@link years}. */
  readonly byYear: readonly number[];
  /** Commits per weekday (index 0 = Sunday). */
  readonly byWeekday: readonly number[];
  readonly total: number;
  readonly max: number;
}

/** Bins commit timestamps by calendar year and weekday. */
export function yearWeekday(times: Iterable<string>): YearWeekdayCard {
  const rows = new Map<number, number[]>();
  const byWeekday = new Array<number>(7).fill(0);
  let total = 0;

  for (const iso of times) {
    const parts = wallClockParts(iso);
    if (!parts) continue;
    let row = rows.get(parts.year);
    if (!row) rows.set(parts.year, (row = new Array<number>(7).fill(0)));
    row[parts.day]++;
    byWeekday[parts.day]++;
    total++;
  }

  const years = [...rows.keys()].sort((a, b) => b - a); // newest first
  const grid = years.map((year) => rows.get(year)!);
  const byYear = grid.map((row) => row.reduce((sum, count) => sum + count, 0));
  let max = 0;
  for (const row of grid) for (const count of row) if (count > max) max = count;

  return { years, grid, byYear, byWeekday, total, max };
}
