/**
 * Minimal unified-diff (patch) parsing and application.
 *
 * GitHub returns each changed file's unified-diff `patch` inline with the commit
 * (the same response that lists the changed files), so the survival walk can
 * reconstruct a file's new content from the diff already in hand instead of
 * fetching the blob — turning one request-per-changed-file into none. The applier
 * verifies every context/removed line against the old content and returns `null`
 * on any mismatch (a truncated patch, CRLF/BOM skew, or a stale snapshot), so the
 * caller can fall back to fetching the blob and never trusts a patch blindly.
 */

/** One hunk of a unified diff. */
export interface PatchHunk {
  /** 1-based first old line the hunk covers (the insertion point when `oldCount` is 0). */
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  /** Body lines in order, each a context (` `), addition (`+`) or removal (`-`). */
  readonly lines: readonly PatchLine[];
}

export interface PatchLine {
  readonly kind: 'context' | 'add' | 'del';
  readonly text: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses a unified-diff patch body (as GitHub's per-file `patch`, which is the
 * hunks only — no `diff --git`/`---`/`+++` preamble) into {@link PatchHunk}s.
 * Tolerant of a leading preamble and of `\ No newline at end of file` markers.
 */
export function parsePatch(patch: string): PatchHunk[] {
  const hunks: {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: PatchLine[];
  }[] = [];
  let current: (typeof hunks)[number] | null = null;

  for (const raw of patch.split('\n')) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // preamble before the first hunk
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    const marker = raw[0];
    if (marker === '+') current.lines.push({ kind: 'add', text: raw.slice(1) });
    else if (marker === '-') current.lines.push({ kind: 'del', text: raw.slice(1) });
    else if (marker === ' ') current.lines.push({ kind: 'context', text: raw.slice(1) });
    else current = null; // an unexpected line ends the hunk run (e.g. a new file's header)
  }
  return hunks;
}

/**
 * Applies parsed `hunks` to `oldLines`, returning the new file lines — or `null`
 * when the patch does not apply cleanly (context/removal mismatch, or an
 * out-of-range/out-of-order hunk), so the caller can fall back to the blob.
 */
export function applyPatch(
  oldLines: readonly string[],
  hunks: readonly PatchHunk[],
): string[] | null {
  const out: string[] = [];
  let oldIdx = 0; // 0-based cursor into oldLines

  for (const hunk of hunks) {
    // Copy untouched lines before the hunk. A hunk with old content starts at
    // `oldStart` (1-based); a pure insertion (`oldCount === 0`) sits *after*
    // `oldStart`, so the cursor lands on `oldStart` rather than `oldStart - 1`.
    const copyUntil = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (copyUntil < oldIdx || copyUntil > oldLines.length) return null;
    while (oldIdx < copyUntil) out.push(oldLines[oldIdx++]);

    let oldConsumed = 0;
    let newProduced = 0;
    for (const line of hunk.lines) {
      if (line.kind === 'add') {
        out.push(line.text);
        newProduced++;
      } else {
        // context or del must match the old content exactly
        if (oldIdx >= oldLines.length || oldLines[oldIdx] !== line.text) return null;
        if (line.kind === 'context') {
          out.push(oldLines[oldIdx]);
          newProduced++;
        }
        oldIdx++;
        oldConsumed++;
      }
    }
    // The body must consume/produce exactly what the header promised; a truncated
    // or malformed hunk that merely matched its prefix is rejected so the caller
    // falls back to the blob instead of silently dropping part of the diff.
    if (oldConsumed !== hunk.oldCount || newProduced !== hunk.newCount) return null;
  }

  while (oldIdx < oldLines.length) out.push(oldLines[oldIdx++]);
  return out;
}
