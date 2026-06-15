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
 * Maps a new-side range onto the old side of the same diff. Each edge follows
 * the old line at the same offset within a replaced block (clamped to the
 * block), so a traced range keeps its size as it is followed back rather than
 * ballooning to a rewritten block's full old extent — a single line stays a
 * single line, an N-line selection stays about N lines. Returns null when the
 * whole range was introduced by this very diff: there is nothing older to
 * follow.
 */
export function mapRangeToParent(
  regions: readonly ChangeRegion[],
  range: LineRange,
): LineRange | null {
  const start = Math.max(1, mapEdge(regions, range.start, 'start'));
  const end = mapEdge(regions, range.end, 'end');
  return start > end ? null : { start, end };
}

/**
 * Like {@link mapRangeToParent}, but treats exact same-file moves as line
 * continuity instead of introducing the range at the move commit. Minimal
 * line diffs represent moves as a removal plus an insertion, so the regular
 * edge mapping sees only a pure add and stops. Pairing identical add/remove
 * runs lets tracing and blame follow the line back to its old position while
 * still counting the move commit as a structural change.
 */
export function mapRangeToParentIncludingMoves(
  ops: readonly DiffOp[],
  regions: readonly ChangeRegion[],
  range: LineRange,
): LineRange | null {
  const mapped = mapRangeToParent(regions, range);
  if (mapped) return mapped;

  const moved = movedLinePairs(ops);
  const mappedLines: number[] = [];
  for (let line = range.start; line <= range.end; line++) {
    const oldLine = moved.get(line);
    if (oldLine !== undefined) mappedLines.push(oldLine);
  }
  if (mappedLines.length === 0) return null;
  return { start: Math.min(...mappedLines), end: Math.max(...mappedLines) };
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

function mapEdge(regions: readonly ChangeRegion[], line: number, edge: 'start' | 'end'): number {
  let delta = 0;
  for (const region of regions) {
    if (region.newCount > 0) {
      const last = region.newStart + region.newCount - 1;
      if (line >= region.newStart && line <= last) {
        // The edge sits on a block of new-side lines.
        if (region.oldCount === 0) {
          // Pure insertion — nothing older here. `start` maps to the gap and
          // `end` one short of it, so a wholly-introduced range yields null.
          return edge === 'start' ? region.oldStart : region.oldStart - 1;
        }
        // Follow the old line at the same offset within the replaced block
        // (clamped to it). Each edge tracks its own position, so a traced
        // range keeps its size across a rewrite — one line stays one line,
        // N lines stay ~N — instead of ballooning to the block's full old
        // extent, which for a near-whole-file rewrite selected everything.
        const offset = Math.min(line - region.newStart, region.oldCount - 1);
        return region.oldStart + offset;
      }
      if (last >= line) break; // first region beyond the edge — nothing else shifts it
      delta += region.oldCount - region.newCount;
    } else {
      if (region.newStart > line) break;
      delta += region.oldCount;
    }
  }
  return line + delta;
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
 * The changed core of a hunk in new-side coordinates: every added line
 * plus, for runs of pure removals, the surviving lines around the gap so
 * the deleted block itself stays inside the tracked range. Context lines
 * are not included. For a removal at the very end of the file the range
 * deliberately reaches one line past it — that is where the gap lies.
 */
export function hunkChangeRanges(hunk: DiffHunk): LineRange[] {
  const ranges: LineRange[] = [];
  let nextNew = hunk.newCount > 0 ? hunk.newStart : hunk.newStart + 1;
  let inRun = false;
  let runHasAdd = false;
  let runGap = 0;
  let min = Infinity;
  let max = -Infinity;

  const closeRun = (): void => {
    if (!inRun) return;
    ranges.push(
      runHasAdd ? { start: min, end: max } : { start: Math.max(1, runGap - 1), end: runGap },
    );
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
    }
    if (op.kind === 'add') {
      runHasAdd = true;
      min = Math.min(min, op.newLine);
      max = Math.max(max, op.newLine);
      nextNew = op.newLine + 1;
    }
  }
  closeRun();
  return ranges;
}

export function hunkChangedRange(hunk: DiffHunk): LineRange | null {
  const ranges = hunkChangeRanges(hunk);
  if (ranges.length === 0) return null;
  return {
    start: Math.min(...ranges.map((range) => range.start)),
    end: Math.max(...ranges.map((range) => range.end)),
  };
}
