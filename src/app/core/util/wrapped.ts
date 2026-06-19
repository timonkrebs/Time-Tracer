/**
 * "Git Wrapped" stats — the time-based highlights behind the year-in-review
 * cards (busiest day, longest commit streak). Pure and deterministic; the rest
 * of a card's data (top contributor, hottest file, …) is assembled in the view
 * from the analyses already on hand.
 *
 * Dates are taken from each commit's own wall-clock (the date as written in the
 * timestamp), matching the punch card, so a "day" is the author's local day.
 */

/** The single calendar day with the most commits. */
export interface BusiestDay {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly count: number;
}

/** The longest run of consecutive calendar days with at least one commit. */
export interface Streak {
  readonly days: number;
  readonly start: string;
  readonly end: string;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** The `YYYY-MM-DD` wall-clock date of an ISO timestamp, or null. */
function dateKey(iso: string): string | null {
  const match = DATE_RE.exec(iso);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/** Days since the epoch for a `YYYY-MM-DD` key (for consecutive-day maths). */
function dayNumber(key: string): number {
  return Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)) / 86_400_000;
}

/** The calendar day with the most commits (ties broken by the earlier date). */
export function busiestDay(times: Iterable<string>): BusiestDay | null {
  const counts = new Map<string, number>();
  for (const iso of times) {
    const day = dateKey(iso);
    if (day) counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  let best: BusiestDay | null = null;
  for (const [date, count] of counts) {
    if (!best || count > best.count || (count === best.count && date < best.date)) {
      best = { date, count };
    }
  }
  return best;
}

/** The longest streak of consecutive committing days (ties broken by the earlier run). */
export function longestStreak(times: Iterable<string>): Streak | null {
  const days = [...new Set([...times].map(dateKey).filter((d): d is string => d !== null))].sort();
  if (days.length === 0) return null;

  let bestStart = days[0];
  let bestEnd = days[0];
  let bestLen = 1;
  let runStart = days[0];
  let runLen = 1;
  for (let i = 1; i < days.length; i++) {
    if (dayNumber(days[i]) - dayNumber(days[i - 1]) === 1) {
      runLen++;
    } else {
      runStart = days[i];
      runLen = 1;
    }
    if (runLen > bestLen) {
      bestLen = runLen;
      bestStart = runStart;
      bestEnd = days[i];
    }
  }
  return { days: bestLen, start: bestStart, end: bestEnd };
}
