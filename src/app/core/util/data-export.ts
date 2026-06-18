/**
 * Pure serialization helpers for the data exports (Insights and Ownership
 * tables → CSV/JSON). Domain-agnostic: callers build the rows from their own
 * typed data, these turn them into well-formed files. The sibling
 * {@link ./download download.ts} hands the result to the browser.
 */

/** MIME type for the CSV downloads (UTF-8, so non-ASCII author names survive). */
export const CSV_MIME = 'text/csv;charset=utf-8';
export const JSON_MIME = 'application/json';

/**
 * Builds an RFC 4180-style CSV from a header row and value rows. Cells are
 * escaped via {@link csvCell} and lines are joined with CRLF. Numbers, strings,
 * booleans and nullish values are all accepted; nullish renders as empty.
 */
export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n');
}

/**
 * Escapes one CSV cell: a value containing a comma, double-quote, CR or LF is
 * wrapped in double-quotes with embedded quotes doubled. Nullish and non-finite
 * numbers become an empty cell.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && !Number.isFinite(value)) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Pretty-prints a value as JSON (2-space indent). */
export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Rounds to `digits` decimals, dropping trailing zeros — keeps exports tidy. */
export function round(value: number, digits = 3): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Turns a label (a repo name, file or folder) into a safe filename fragment:
 * lower-cased, non-alphanumerics collapsed to single dashes, trimmed. Falls
 * back to `repository` so a download always has a name.
 */
export function fileSlug(label: string): string {
  const slug = (label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'repository';
}
