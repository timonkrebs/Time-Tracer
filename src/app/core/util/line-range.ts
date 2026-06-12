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
 * Maps a new-side range onto the old side of the same diff. An edge that
 * falls inside a replaced block expands to the block's old extent (as
 * git's line-log does), so the range keeps covering everything the change
 * replaced — including lines that only exist in the older version. Returns
 * null when the whole range was introduced by this very diff: there is
 * nothing older to follow.
 */
export function mapRangeToParent(
  regions: readonly ChangeRegion[],
  range: LineRange,
): LineRange | null {
  const start = Math.max(1, mapEdge(regions, range.start, 'start'));
  const end = mapEdge(regions, range.end, 'end');
  return start > end ? null : { start, end };
}

function mapEdge(regions: readonly ChangeRegion[], line: number, edge: 'start' | 'end'): number {
  let delta = 0;
  for (const region of regions) {
    if (region.newCount > 0) {
      const last = region.newStart + region.newCount - 1;
      if (line >= region.newStart && line <= last) {
        return edge === 'start' ? region.oldStart : region.oldStart + region.oldCount - 1;
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
