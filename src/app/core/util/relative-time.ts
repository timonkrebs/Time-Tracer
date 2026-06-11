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
