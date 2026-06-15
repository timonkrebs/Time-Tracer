/**
 * Line-range tracking for the per-hunk history filter.
 *
 * Mirrors the idea of `git log -L <start>,<end>:<file>`: a line range,
 * anchored at one version of a file, is followed backwards through the
 * file's history. For each adjacent version pair the minimal diff tells
 * us whether the older→newer step changed lines inside the range — and
 * how to map the range onto the older version's coordinates so it can
 * keep being followed.
 */

import { DiffHunk, DiffOp } from './diff';

/** 1-based inclusive line range. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Parses a `line` query param into a 1-based range. Accepts a single line
 * (`"18"`) or an inclusive span (`"18-19"`); returns null for anything else,
 * so a malformed deep link simply highlights nothing.
 */
export function parseLineRange(raw: string | null | undefined): LineRange | null {
  if (!raw) return null;
  const match = /^(\d+)(?:-(\d+))?$/.exec(raw);
  if (!match) return null;
  const start = Number(match[1]);
  if (!Number.isInteger(start) || start < 1) return null;
  if (match[2] === undefined) return { start, end: start };
  const end = Number(match[2]);
  if (!Number.isInteger(end) || end < start) return null;
  return { start, end };
}

/** Formats a range for the `line` query param: `"18"` or `"18-19"`. */
export function formatLineRange(range: LineRange): string {
  return range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
}

/**
 * One maximal run of non-equal ops: `oldCount` lines starting at `oldStart`
 * were replaced by `newCount` lines starting at `newStart`. A zero-count
 * side marks a pure insertion/removal: the region then sits in the gap
 * between that side's lines `start - 1` and `start`.
 */
export interface ChangeRegion {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

/** Groups an edit script into change regions (no context, in file order). */
export function changeRegions(ops: readonly DiffOp[]): ChangeRegion[] {
  const regions: { oldStart: number; oldCount: number; newStart: number; newCount: number }[] = [];
  let oldPos = 1;
  let newPos = 1;
  let open = false;
  for (const op of ops) {
    if (op.kind === 'equal') {
      open = false;
      oldPos++;
      newPos++;
      continue;
    }
    if (!open) {
      open = true;
      regions.push({ oldStart: oldPos, oldCount: 0, newStart: newPos, newCount: 0 });
    }
    const region = regions[regions.length - 1];
    if (op.kind === 'remove') {
      region.oldCount++;
      oldPos++;
    } else {
      region.newCount++;
      newPos++;
    }
  }
  return regions;
}

/**
 * Whether a change region touches `range` on the new side. A pure removal
 * (no new-side lines) touches when its gap lies at or inside the range,
 * i.e. between `start - 1` and `end`.
 */
export function regionTouchesRange(region: ChangeRegion, range: LineRange): boolean {
  if (region.newCount === 0) {
    return region.newStart >= range.start && region.newStart <= range.end;
  }
  const last = region.newStart + region.newCount - 1;
  return region.newStart <= range.end && last >= range.start;
}

/** New-side trace range for one contiguous change run. */
export function changeRegionRange(region: ChangeRegion): LineRange {
  if (region.newCount > 0) {
    return { start: region.newStart, end: region.newStart + region.newCount - 1 };
  }
  return { start: Math.max(1, region.newStart - 1), end: region.newStart };
}

/**
 * Maps every surviving new-side line onto the older version by *content* rather
 * than position: equal lines map exactly, exact same-file moves map to the
 * line's old position, and edited blocks map by offset within the block. Lines
 * introduced by this diff (pure additions with no moved twin) are absent from
 * the map. This unifies move-following with the ordinary mapping so a moved
 * line is followed wherever it went, not just when the whole range moved.
 */
export function newerToOlderLineMap(ops: readonly DiffOp[]): ReadonlyMap<number, number> {
  const map = new Map<number, number>();
  // Equal lines map exactly.
  for (const op of ops) {
    if (op.kind === 'equal') map.set(op.newLine, op.oldLine);
  }
  // Exact moves take priority: a line carried elsewhere is the same line, so
  // follow it to its old position even if its surroundings changed.
  for (const [newLine, oldLine] of movedLinePairs(ops)) map.set(newLine, oldLine);
  // Edited blocks (both sides non-empty): an added line not explained by a move
  // follows the replaced old line at the same offset (clamped to the block), so
  // an edit keeps the line by position instead of treating it as introduced.
  for (const region of changeRegions(ops)) {
    if (region.oldCount === 0 || region.newCount === 0) continue;
    for (let i = 0; i < region.newCount; i++) {
      const newLine = region.newStart + i;
      if (map.has(newLine)) continue;
      map.set(newLine, region.oldStart + Math.min(i, region.oldCount - 1));
    }
  }
  return map;
}

/**
 * A new-side `range` mapped onto the older version by following the content of
 * each line it covers (see {@link newerToOlderLineMap}) and spanning where
 * those lines land — so moves are followed and a selection keeps its size
 * instead of ballooning across a rewrite. Returns null when every line in the
 * range was introduced by this diff: there is nothing older to follow.
 */
export function followRange(ops: readonly DiffOp[], range: LineRange): LineRange | null {
  const map = newerToOlderLineMap(ops);
  let start = Infinity;
  let end = -Infinity;
  for (let line = range.start; line <= range.end; line++) {
    const old = map.get(line);
    if (old === undefined) continue;
    start = Math.min(start, old);
    end = Math.max(end, old);
  }
  return start === Infinity ? null : { start, end };
}

/**
 * New-side line -> old-side line for exact add/remove runs that are likely
 * same-file moves. Coordinates are 1-based, matching {@link DiffOp}.
 */
export function movedLinePairs(ops: readonly DiffOp[]): ReadonlyMap<number, number> {
  const removes = lineRuns(ops, 'remove');
  const adds = lineRuns(ops, 'add');
  if (removes.length === 0 || adds.length === 0) return new Map();

  const usedOldLines = new Set<number>();
  const pairs = new Map<number, number>();
  for (const add of adds) {
    const match = findRemovedRun(add, removes, usedOldLines);
    if (!match) continue;
    for (let i = 0; i < add.texts.length; i++) {
      const oldLine = match.run.lines[match.offset + i];
      pairs.set(add.lines[i], oldLine);
      usedOldLines.add(oldLine);
    }
  }
  return pairs;
}

interface LineRun {
  readonly lines: readonly number[];
  readonly texts: readonly string[];
}

function lineRuns(ops: readonly DiffOp[], kind: 'add' | 'remove'): LineRun[] {
  const runs: LineRun[] = [];
  let lines: number[] = [];
  let texts: string[] = [];
  const flush = (): void => {
    if (lines.length === 0) return;
    runs.push({ lines, texts });
    lines = [];
    texts = [];
  };

  for (const op of ops) {
    if (op.kind !== kind) {
      flush();
      continue;
    }
    if (op.kind === 'add') lines.push(op.newLine);
    else lines.push(op.oldLine);
    texts.push(op.text);
  }
  flush();
  return runs;
}

function findRemovedRun(
  add: LineRun,
  removes: readonly LineRun[],
  usedOldLines: ReadonlySet<number>,
): { run: LineRun; offset: number } | null {
  for (const run of removes) {
    for (let offset = 0; offset <= run.texts.length - add.texts.length; offset++) {
      let ok = true;
      for (let i = 0; i < add.texts.length; i++) {
        if (add.texts[i] !== run.texts[offset + i] || usedOldLines.has(run.lines[offset + i])) {
          ok = false;
          break;
        }
      }
      if (ok) return { run, offset };
    }
  }
  return null;
}

/**
 * One contiguous change run in a hunk, with the new-side trace range and — for
 * a pure removal — the old-side span of the deleted lines.
 */
export interface ChangeRun {
  /**
   * New-side trace range: the added lines, or — for a pure removal — the
   * surviving lines bracketing the gap. For a removal at the very end of the
   * file it reaches one line past it, where the gap lies.
   */
  readonly newRange: LineRange;
  /**
   * Old-side span of the run's removed lines, set only when the run *only*
   * removes. Lets a deletion be traced by the lines it removed rather than by
   * their surviving neighbours.
   */
  readonly oldRange: LineRange | null;
}

/** Splits a hunk into its change runs (see {@link ChangeRun}), in file order. */
export function hunkChangeRuns(hunk: DiffHunk): ChangeRun[] {
  const runs: ChangeRun[] = [];
  let nextNew = hunk.newCount > 0 ? hunk.newStart : hunk.newStart + 1;
  let inRun = false;
  let runHasAdd = false;
  let runGap = 0;
  let min = Infinity;
  let max = -Infinity;
  let oldMin = Infinity;
  let oldMax = -Infinity;

  const closeRun = (): void => {
    if (!inRun) return;
    const newRange = runHasAdd
      ? { start: min, end: max }
      : { start: Math.max(1, runGap - 1), end: runGap };
    const oldRange = !runHasAdd && oldMin !== Infinity ? { start: oldMin, end: oldMax } : null;
    runs.push({ newRange, oldRange });
    inRun = false;
  };

  for (const op of hunk.ops) {
    if (op.kind === 'equal') {
      closeRun();
      nextNew = op.newLine + 1;
      continue;
    }
    if (!inRun) {
      inRun = true;
      runHasAdd = false;
      runGap = nextNew;
      min = Infinity;
      max = -Infinity;
      oldMin = Infinity;
      oldMax = -Infinity;
    }
    if (op.kind === 'add') {
      runHasAdd = true;
      min = Math.min(min, op.newLine);
      max = Math.max(max, op.newLine);
      nextNew = op.newLine + 1;
    } else {
      oldMin = Math.min(oldMin, op.oldLine);
      oldMax = Math.max(oldMax, op.oldLine);
    }
  }
  closeRun();
  return runs;
}

/**
 * The changed core of a hunk in new-side coordinates: every added line
 * plus, for runs of pure removals, the surviving lines around the gap so
 * the deleted block itself stays inside the tracked range. Context lines
 * are not included. For a removal at the very end of the file the range
 * deliberately reaches one line past it — that is where the gap lies.
 */
export function hunkChangeRanges(hunk: DiffHunk): LineRange[] {
  return hunkChangeRuns(hunk).map((run) => run.newRange);
}

export function hunkChangedRange(hunk: DiffHunk): LineRange | null {
  const ranges = hunkChangeRanges(hunk);
  if (ranges.length === 0) return null;
  return {
    start: Math.min(...ranges.map((range) => range.start)),
    end: Math.max(...ranges.map((range) => range.end)),
  };
}
