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

/** Weekday + hour of an ISO timestamp's own wall-clock, or null when unparseable. */
export function wallClockParts(iso: string): { day: number; hour: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):/.exec(iso);
  if (!match) return null;
  const [, year, month, dayOfMonth, hour] = match;
  // Weekday of the written calendar date (computed in UTC so it isn't shifted
  // by the runtime's timezone).
  const day = new Date(Date.UTC(+year, +month - 1, +dayOfMonth)).getUTCDay();
  if (Number.isNaN(day)) return null;
  return { day, hour: +hour };
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
