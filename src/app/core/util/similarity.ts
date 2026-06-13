/**
 * Content-similarity metrics for predecessor detection (file renames and
 * hunk origins).
 *
 * Levenshtein is used only where it is strong — comparing two short lines.
 * Whole files are compared with a line-structured hybrid: exact lines via
 * the minimal Myers diff, edited lines via per-line Levenshtein on the
 * changed pairs. A block of lines is located inside a file with a local
 * alignment over lines (Smith–Waterman), so a moved block still matches
 * when lines were edited or inserted inside it. Character-level edit
 * distance over whole files would be O(n·m) in characters and blind to
 * line structure, so it is deliberately not used at that scale.
 */

import { diffLines, splitLines } from './diff';

/** Beyond this length per-line Levenshtein falls back to bigram Dice. */
const LEVENSHTEIN_MAX = 400;
/** Line pairs below this similarity count as unrelated, to keep noise out. */
const LINE_MATCH_MIN = 0.5;
/** Minimal confidence for a block-origin match to be reported at all. */
const ORIGIN_MIN_SCORE = 0.35;
/** Blocks are truncated to this many lines before the alignment. */
const BLOCK_CAP = 100;
/** Local-alignment parameters: reward exact lines, tolerate edits/gaps. */
const MATCH = 2;
const MISMATCH = -1;
const GAP = -1;

/**
 * Normalized Levenshtein similarity of two short strings (0..1). Very long
 * inputs fall back to bigram Dice, which is O(n+m) and close enough for
 * ranking purposes.
 */
export function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  const longest = Math.max(n, m);
  if (longest > LEVENSHTEIN_MAX) return bigramDice(a, b);

  let prev = new Int32Array(m + 1);
  let curr = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const substitution = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, substitution);
    }
    [prev, curr] = [curr, prev];
  }
  return 1 - prev[m] / longest;
}

/** Dice coefficient over character bigram multisets (0..1). */
function bigramDice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2);
    const left = counts.get(gram) ?? 0;
    if (left > 0) {
      counts.set(gram, left - 1);
      shared++;
    }
  }
  return (2 * shared) / (a.length + b.length - 2);
}

/**
 * Whole-file similarity (0..1) that — unlike {@link lineSimilarity} — also
 * credits lines that were *edited* rather than replaced: the minimal line
 * diff aligns the files, and within each change region removed and added
 * lines are paired positionally and scored with per-line Levenshtein.
 * A file that was moved and touched up throughout (renamed identifiers,
 * re-indentation) keeps a high score instead of collapsing to the few
 * lines that survived verbatim.
 */
export function fuzzyLineSimilarity(oldText: string, newText: string): number {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length === 0 && newLines.length === 0) return 1;
  if (oldLines.length === 0 || newLines.length === 0) return 0;

  let score = 0;
  let removes: string[] = [];
  let adds: string[] = [];
  const flush = (): void => {
    const pairs = Math.min(removes.length, adds.length);
    for (let i = 0; i < pairs; i++) {
      const s = levenshteinSimilarity(removes[i].trim(), adds[i].trim());
      if (s >= LINE_MATCH_MIN) score += s;
    }
    removes = [];
    adds = [];
  };
  for (const op of diffLines(oldLines, newLines)) {
    if (op.kind === 'equal') {
      flush();
      score += 1;
    } else if (op.kind === 'remove') {
      removes.push(op.text);
    } else {
      adds.push(op.text);
    }
  }
  flush();
  return score / Math.max(oldLines.length, newLines.length);
}

/** Where a block of lines matches inside a file, and how well. */
export interface BlockMatch {
  /** 1-based line in the searched file where the match begins. */
  readonly line: number;
  /** 0..1 — how much of the block is present at that location. */
  readonly score: number;
}

/**
 * Locates the best occurrence of `block` inside `file` with a local
 * alignment over lines (Smith–Waterman): exact, whitespace-trimmed line
 * matches anchor the alignment, gaps tolerate lines inserted or removed
 * inside a moved block, and aligned-but-edited pairs are re-scored with
 * per-line Levenshtein. Trivial lines (braces, blanks, short fragments)
 * carry no weight unless the whole block is trivial, and a match needs at
 * least one exact weighted line — vague similarity alone never produces an
 * origin. Blocks longer than {@link BLOCK_CAP} lines are matched by their
 * first lines.
 */
export function findBlockOrigin(
  block: readonly string[],
  file: readonly string[],
): BlockMatch | null {
  if (block.length === 0 || file.length === 0) return null;
  const blockTrim = block.slice(0, BLOCK_CAP).map((line) => line.trim());
  const fileTrim = file.map((line) => line.trim());

  // Intern the lines so the alignment compares integers, not strings.
  const ids = new Map<string, number>();
  const idOf = (text: string): number => {
    let id = ids.get(text);
    if (id === undefined) {
      id = ids.size;
      ids.set(text, id);
    }
    return id;
  };
  const blockIds = blockTrim.map(idOf);
  const fileIds = fileTrim.map(idOf);

  const significant = blockTrim.map(isSignificantLine);
  const weighted = significant.some(Boolean) ? significant : blockTrim.map(() => true);

  // Local alignment: two score rows plus a full direction matrix for the
  // traceback. 0 = stop, 1 = diagonal, 2 = skip a block line, 3 = skip a
  // file line.
  const rows = blockIds.length;
  const cols = fileIds.length;
  const dir = new Uint8Array((rows + 1) * (cols + 1));
  let prev = new Int32Array(cols + 1);
  let curr = new Int32Array(cols + 1);
  let bestScore = 0;
  let bestRow = 0;
  let bestCol = 0;
  for (let i = 1; i <= rows; i++) {
    const id = blockIds[i - 1];
    for (let j = 1; j <= cols; j++) {
      const diagonal = prev[j - 1] + (id === fileIds[j - 1] ? MATCH : MISMATCH);
      const up = prev[j] + GAP;
      const left = curr[j - 1] + GAP;
      let value = diagonal;
      let direction = 1;
      if (up > value) {
        value = up;
        direction = 2;
      }
      if (left > value) {
        value = left;
        direction = 3;
      }
      if (value <= 0) {
        value = 0;
        direction = 0;
      }
      curr[j] = value;
      dir[i * (cols + 1) + j] = direction;
      if (value > bestScore) {
        bestScore = value;
        bestRow = i;
        bestCol = j;
      }
    }
    [prev, curr] = [curr, prev];
  }
  if (bestScore <= 0) return null;

  // Traceback from the best cell to the aligned line pairs.
  const alignedFileLine = new Map<number, number>();
  let i = bestRow;
  let j = bestCol;
  while (i > 0 && j > 0) {
    const direction = dir[i * (cols + 1) + j];
    if (direction === 0) break;
    if (direction === 1) {
      alignedFileLine.set(i - 1, j - 1);
      i--;
      j--;
    } else if (direction === 2) {
      i--;
    } else {
      j--;
    }
  }
  if (alignedFileLine.size === 0) return null;

  // The local alignment trims poorly-scoring edges, but an edited line just
  // above or below the matched core is still part of the moved block —
  // extend diagonally past both ends and let the fuzzy re-scoring decide
  // what those edge lines are worth.
  const blockIndexes = [...alignedFileLine.keys()];
  const minBlock = Math.min(...blockIndexes);
  const maxBlock = Math.max(...blockIndexes);
  const maxFile = alignedFileLine.get(maxBlock)!;
  for (let b = minBlock - 1, f = alignedFileLine.get(minBlock)! - 1; b >= 0 && f >= 0; b--, f--) {
    alignedFileLine.set(b, f);
  }
  for (let b = maxBlock + 1, f = maxFile + 1; b < rows && f < cols; b++, f++) {
    alignedFileLine.set(b, f);
  }

  let exactAnchor = false;
  let score = 0;
  let denominator = 0;
  for (let k = 0; k < rows; k++) {
    if (!weighted[k]) continue;
    denominator++;
    const at = alignedFileLine.get(k);
    if (at === undefined) continue;
    if (blockIds[k] === fileIds[at]) {
      score += 1;
      exactAnchor = true;
    } else {
      const s = levenshteinSimilarity(blockTrim[k], fileTrim[at]);
      if (s >= LINE_MATCH_MIN) score += s;
    }
  }
  if (!exactAnchor || denominator === 0) return null;
  const normalized = score / denominator;
  if (normalized < ORIGIN_MIN_SCORE) return null;
  return { line: Math.min(...alignedFileLine.values()) + 1, score: normalized };
}

/** Lines too generic to identify code on their own (blanks, braces…). */
function isSignificantLine(trimmed: string): boolean {
  return trimmed.length >= 4;
}
