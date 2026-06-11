const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** Formats an ISO timestamp as a coarse relative phrase, e.g. `3 years ago`. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 45) return 'just now';
  const rtf = new Intl.RelativeTimeFormat('en');
  for (const [unit, span] of UNITS) {
    if (seconds >= span) return rtf.format(-Math.round(seconds / span), unit);
  }
  return rtf.format(-1, 'minute');
}

/** Abbreviates a commit sha for display. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Formats an ISO timestamp as `dd.mm.yyyy` (UTC), e.g. `08.07.2022`. */
export function shortDate(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${date.getUTCFullYear()}`;
}
