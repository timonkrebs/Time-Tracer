/**
 * Tiny fuzzy matcher for the file finder.
 *
 * A query matches a target when its characters appear in order (a
 * case-insensitive subsequence). The match is scored so that the kinds of hits
 * a human means when they type a few letters of a path rank highest:
 * characters that land on a word boundary (after `/ \ . _ -` or a camelCase
 * hump) and runs of consecutive characters are rewarded, longer targets are
 * mildly penalised. The matched character positions come back too, so the UI
 * can highlight exactly what matched.
 */

export interface FuzzyMatch {
  /** Higher is better; only meaningful relative to other matches. */
  readonly score: number;
  /** Indices into the target that matched, ascending. */
  readonly positions: readonly number[];
}

/** One run of a string, flagged as matched (to highlight) or not. */
export interface Segment {
  readonly text: string;
  readonly match: boolean;
}

const CONSECUTIVE_BONUS = 8;
const BOUNDARY_BONUS = 10;
const START_BONUS = 6;
const LENGTH_PENALTY = 0.1;
/** Lifts any filename hit above any match that only touches the directory. */
const NAME_BONUS = 100;

const SEPARATOR = /[\\/._\- ]/;

/**
 * Scores `query` against `target`, or returns null when it is not a
 * subsequence. An empty query matches everything with a neutral score.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, positions: [] };
  if (query.length > target.length) return null;

  const q = query.toLowerCase();
  const lower = target.toLowerCase();
  const positions: number[] = [];
  let qi = 0;
  let prev = -1;
  let score = 0;

  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] !== q[qi]) continue;

    let bonus = 1;
    if (i === prev + 1) bonus += CONSECUTIVE_BONUS;
    if (isBoundary(target, i)) bonus += BOUNDARY_BONUS;
    if (i === 0) bonus += START_BONUS;
    score += bonus;

    positions.push(i);
    prev = i;
    qi++;
  }

  if (qi < q.length) return null;
  score -= target.length * LENGTH_PENALTY;
  return { score, positions };
}

/**
 * Like {@link fuzzyMatch}, but tuned for file paths: a hit inside the file
 * name (the part after the last `/`) is strongly preferred, since that is what
 * people usually type. Falls back to matching the whole path. Returned
 * positions are always relative to the full path.
 */
export function fuzzyMatchPath(query: string, path: string): FuzzyMatch | null {
  const slash = path.lastIndexOf('/');
  if (slash >= 0) {
    const name = path.slice(slash + 1);
    const inName = fuzzyMatch(query, name);
    if (inName) {
      return {
        score: inName.score + NAME_BONUS,
        positions: inName.positions.map((p) => p + slash + 1),
      };
    }
  }
  return fuzzyMatch(query, path);
}

/** Splits `text` into matched/unmatched runs from ascending match positions. */
export function highlightSegments(text: string, positions: readonly number[]): Segment[] {
  if (positions.length === 0) return text ? [{ text, match: false }] : [];
  const segments: Segment[] = [];
  let i = 0;
  let p = 0;
  while (i < text.length) {
    const matched = p < positions.length && positions[p] === i;
    let j = i;
    if (matched) {
      while (p < positions.length && positions[p] === j) {
        p++;
        j++;
      }
    } else {
      while (j < text.length && !(p < positions.length && positions[p] === j)) j++;
    }
    segments.push({ text: text.slice(i, j), match: matched });
    i = j;
  }
  return segments;
}

/** A character starts a "word" — string start, after a separator, or a camelCase hump. */
function isBoundary(target: string, i: number): boolean {
  if (i === 0) return true;
  const prev = target[i - 1];
  if (SEPARATOR.test(prev)) return true;
  const ch = target[i];
  return /[a-z0-9]/.test(prev) && ch >= 'A' && ch <= 'Z';
}
