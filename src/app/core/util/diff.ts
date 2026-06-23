/**
 * Line-based diffing for Time Tracer.
 *
 * Implements Myers' O(ND) difference algorithm in its linear-space
 * (middle-snake / divide & conquer) variant, producing a *minimal* edit
 * script. Minimality matters here: the upcoming blame milestone attributes
 * lines to commits via these diffs, and a sloppy diff would mis-blame lines
 * that never actually changed.
 */

export type DiffOp =
  | {
      readonly kind: 'equal';
      readonly text: string;
      readonly oldLine: number;
      readonly newLine: number;
    }
  | { readonly kind: 'remove'; readonly text: string; readonly oldLine: number }
  | { readonly kind: 'add'; readonly text: string; readonly newLine: number };

export interface DiffHunk {
  /** 1-based first old/new line covered by the hunk (0 when the side is empty). */
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  /** Unified-diff style header, e.g. `@@ -3,7 +3,9 @@`. */
  readonly header: string;
  readonly ops: readonly DiffOp[];
}

export interface FileDiff {
  readonly hunks: readonly DiffHunk[];
  readonly added: number;
  readonly removed: number;
  readonly oldLineCount: number;
  readonly newLineCount: number;
  /** True when the two texts have identical lines. */
  readonly identical: boolean;
}

/** Beyond this product of segment sizes the diff degrades to replace-all. */
const SIZE_GUARD = 25_000_000;

/**
 * Splits file text into lines for diffing: one trailing newline is not a
 * line of its own, and an empty file has zero lines.
 *
 * A leading UTF-8 byte-order mark and CRLF line endings are normalized away
 * first, so two versions (or two files) that differ only in a BOM or in their
 * line endings still diff as equal. Without this every line mismatches: the
 * diff degrades to a full replace, blame mis-attributes every line, and the
 * split view lines nothing up — some hosts serve blobs CRLF and/or BOM-prefixed
 * while others serve the same content as bare LF.
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const normalized = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n');
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return trimmed.split('\n');
}

/** Diffs two file contents and groups the result into context hunks. */
export function computeFileDiff(oldText: string, newText: string, context = 3): FileDiff {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const ops = diffLines(oldLines, newLines);
  const hunks = buildHunks(ops, context);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === 'add') added++;
    else if (op.kind === 'remove') removed++;
  }
  return {
    hunks,
    added,
    removed,
    oldLineCount: oldLines.length,
    newLineCount: newLines.length,
    identical: added === 0 && removed === 0,
  };
}

/** Minimal line edit script turning `oldLines` into `newLines`. */
export function diffLines(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  const raw: { kind: DiffOp['kind']; text: string }[] = [];
  diffRange(oldLines, 0, oldLines.length, newLines, 0, newLines.length, raw);

  // Second pass assigns 1-based line numbers.
  const ops: DiffOp[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of raw) {
    if (op.kind === 'equal') {
      ops.push({ kind: 'equal', text: op.text, oldLine: oldLine++, newLine: newLine++ });
    } else if (op.kind === 'remove') {
      ops.push({ kind: 'remove', text: op.text, oldLine: oldLine++ });
    } else {
      ops.push({ kind: 'add', text: op.text, newLine: newLine++ });
    }
  }
  return ops;
}

function diffRange(
  a: readonly string[],
  aLo: number,
  aHi: number,
  b: readonly string[],
  bLo: number,
  bHi: number,
  out: { kind: DiffOp['kind']; text: string }[],
): void {
  // Common prefix.
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
    out.push({ kind: 'equal', text: a[aLo] });
    aLo++;
    bLo++;
  }
  // Common suffix (emitted after the middle is resolved).
  let suffixLen = 0;
  while (aHi > aLo && bHi > bLo && a[aHi - 1] === b[bHi - 1]) {
    suffixLen++;
    aHi--;
    bHi--;
  }

  if (aLo === aHi) {
    for (let y = bLo; y < bHi; y++) out.push({ kind: 'add', text: b[y] });
  } else if (bLo === bHi) {
    for (let x = aLo; x < aHi; x++) out.push({ kind: 'remove', text: a[x] });
  } else if ((aHi - aLo) * (bHi - bLo) > SIZE_GUARD) {
    // Degenerate inputs: keep it fast and predictable instead of minimal.
    for (let x = aLo; x < aHi; x++) out.push({ kind: 'remove', text: a[x] });
    for (let y = bLo; y < bHi; y++) out.push({ kind: 'add', text: b[y] });
  } else {
    const snake = findMiddleSnake(a, aLo, aHi, b, bLo, bHi);
    diffRange(a, aLo, snake.x, b, bLo, snake.y, out);
    for (let x = snake.x; x < snake.u; x++) out.push({ kind: 'equal', text: a[x] });
    diffRange(a, snake.u, aHi, b, snake.v, bHi, out);
  }

  for (let i = suffixLen; i > 0; i--) {
    out.push({ kind: 'equal', text: a[aHi + suffixLen - i] });
  }
}

interface MiddleSnake {
  x: number;
  y: number;
  u: number;
  v: number;
}

/**
 * Finds a middle snake of an optimal edit path (Myers 1986, section 4b):
 * simultaneous forward and backward D-band searches that meet in the middle,
 * using O(n+m) memory.
 */
function findMiddleSnake(
  a: readonly string[],
  aLo: number,
  aHi: number,
  b: readonly string[],
  bLo: number,
  bHi: number,
): MiddleSnake {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const delta = n - m;
  const odd = (delta & 1) === 1;
  const max = Math.ceil((n + m) / 2) + 1;
  // vf/vb are indexed by diagonal k + max; they store the furthest x reached.
  const vf = new Int32Array(2 * max + 2);
  const vb = new Int32Array(2 * max + 2);

  for (let d = 0; d <= max; d++) {
    // Forward search.
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && vf[max + k - 1] < vf[max + k + 1])) {
        x = vf[max + k + 1];
      } else {
        x = vf[max + k - 1] + 1;
      }
      let y = x - k;
      const x0 = x;
      const y0 = y;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
        x++;
        y++;
      }
      vf[max + k] = x;
      if (odd && delta - k >= -(d - 1) && delta - k <= d - 1) {
        if (vf[max + k] + vb[max + delta - k] >= n) {
          return { x: aLo + x0, y: bLo + y0, u: aLo + x, v: bLo + y };
        }
      }
    }
    // Backward search (on reversed sequences; x counts from the end).
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && vb[max + k - 1] < vb[max + k + 1])) {
        x = vb[max + k + 1];
      } else {
        x = vb[max + k - 1] + 1;
      }
      let y = x - k;
      const x0 = x;
      const y0 = y;
      while (x < n && y < m && a[aLo + n - 1 - x] === b[bLo + m - 1 - y]) {
        x++;
        y++;
      }
      vb[max + k] = x;
      if (!odd && delta - k >= -d && delta - k <= d) {
        if (vb[max + k] + vf[max + delta - k] >= n) {
          return {
            x: aLo + n - x,
            y: bLo + m - y,
            u: aLo + n - x0,
            v: bLo + m - y0,
          };
        }
      }
    }
  }
  // Unreachable for valid inputs; satisfy the type checker defensively.
  return { x: aLo, y: bLo, u: aLo, v: bLo };
}

/** Groups an edit script into unified-diff hunks with `context` equal lines. */
export function buildHunks(ops: readonly DiffOp[], context: number): DiffHunk[] {
  // Old/new lines consumed before each op index (prefix counts).
  const oldBefore = new Array<number>(ops.length + 1);
  const newBefore = new Array<number>(ops.length + 1);
  oldBefore[0] = 0;
  newBefore[0] = 0;
  for (let i = 0; i < ops.length; i++) {
    oldBefore[i + 1] = oldBefore[i] + (ops[i].kind !== 'add' ? 1 : 0);
    newBefore[i + 1] = newBefore[i] + (ops[i].kind !== 'remove' ? 1 : 0);
  }

  // Ranges of op indices that contain changes, padded by context and merged.
  const ranges: { start: number; end: number }[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind === 'equal') {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < ops.length && ops[end].kind !== 'equal') end++;
    const start = Math.max(0, i - context);
    const padded = Math.min(ops.length, end + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end) {
      last.end = padded;
    } else {
      ranges.push({ start, end: padded });
    }
    i = end;
  }

  return ranges.map(({ start, end }) => {
    const slice = ops.slice(start, end);
    const oldCount = oldBefore[end] - oldBefore[start];
    const newCount = newBefore[end] - newBefore[start];
    // Unified convention: a zero-count side anchors to the preceding line.
    const oldStart = oldCount > 0 ? oldBefore[start] + 1 : oldBefore[start];
    const newStart = newCount > 0 ? newBefore[start] + 1 : newBefore[start];
    const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
    return { oldStart, oldCount, newStart, newCount, header, ops: slice };
  });
}

/**
 * Fraction of lines two texts share (0..1), based on the minimal diff.
 * Used to rank rename candidates by content similarity.
 */
export function lineSimilarity(oldText: string, newText: string): number {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length === 0 && newLines.length === 0) return 1;
  const ops = diffLines(oldLines, newLines);
  let equal = 0;
  for (const op of ops) if (op.kind === 'equal') equal++;
  return equal / Math.max(oldLines.length, newLines.length);
}
