/**
 * Folds per-line blame attribution into an authorship summary — the data
 * behind the "who do I ask about this?" view.
 *
 * Works on anything shaped like a blame line (so it stays decoupled from the
 * store): an owning commit, the `'older'` marker for lines that predate the
 * loaded history, or `null` for lines still being attributed.
 */

import type { TreeEntry } from '../models';

const DAY_MS = 86_400_000;
/**
 * Half-life for line staleness (~2 years): a line last edited two years ago is
 * 50% stale, one year ≈ 29%, ten years ≈ 97%. Long enough that "edited last
 * year" and "edited a decade ago" land far apart (a short half-life would
 * saturate both near 1).
 */
const STALE_HALF_LIFE_DAYS = 730;

/** A blame line, reduced to the fields the summary needs. */
export type OwnedLine =
  | {
      readonly commit: {
        readonly sha: string;
        readonly authorName: string;
        /** ISO 8601 author date. */
        readonly authoredAt: string;
      };
    }
  | 'older'
  | null;

/** One author's stake in the summarised lines. */
export interface AuthorShare {
  readonly name: string;
  /** Attributed lines this author owns. */
  readonly lines: number;
  /** Fraction of the attributed lines, 0..1. */
  readonly share: number;
  /** Their most recent owning commit. */
  readonly lastAuthoredAt: string;
  readonly lastSha: string;
}

/** A commit reference for the "last touched" line. */
export interface OwnershipTouch {
  readonly authorName: string;
  readonly authoredAt: string;
  readonly sha: string;
}

export interface OwnershipSummary {
  /** Every line considered (attributed + older + pending). */
  readonly totalLines: number;
  /** Lines with a known owning commit. */
  readonly attributedLines: number;
  /** Lines older than the loaded history pages. */
  readonly olderLines: number;
  /** Lines not yet attributed (blame still computing). */
  readonly pendingLines: number;
  /** Authors, most lines first (ties broken by name). */
  readonly authors: readonly AuthorShare[];
  /** Fewest top authors whose combined share exceeds half the attributed lines. */
  readonly busFactor: number;
  /** Most recent attributed commit across all lines, or null when none. */
  readonly latest: OwnershipTouch | null;
}

interface AuthorAcc {
  lines: number;
  lastTime: number;
  lastSha: string;
  lastIso: string;
}

/** Aggregates blame lines into an {@link OwnershipSummary}. */
export function summarizeOwnership(lines: Iterable<OwnedLine>): OwnershipSummary {
  const byAuthor = new Map<string, AuthorAcc>();
  let total = 0;
  let attributed = 0;
  let older = 0;
  let pending = 0;
  let latest: OwnershipTouch | null = null;
  let latestTime = -Infinity;

  for (const line of lines) {
    total++;
    if (line === null) {
      pending++;
      continue;
    }
    if (line === 'older') {
      older++;
      continue;
    }
    attributed++;
    const { sha, authorName, authoredAt } = line.commit;
    const time = Date.parse(authoredAt) || 0;
    const acc = byAuthor.get(authorName);
    if (acc) {
      acc.lines++;
      if (time >= acc.lastTime) {
        acc.lastTime = time;
        acc.lastSha = sha;
        acc.lastIso = authoredAt;
      }
    } else {
      byAuthor.set(authorName, { lines: 1, lastTime: time, lastSha: sha, lastIso: authoredAt });
    }
    if (time > latestTime) {
      latestTime = time;
      latest = { authorName, authoredAt, sha };
    }
  }

  const authors: AuthorShare[] = [...byAuthor.entries()]
    .map(([name, acc]) => ({
      name,
      lines: acc.lines,
      share: attributed ? acc.lines / attributed : 0,
      lastAuthoredAt: acc.lastIso,
      lastSha: acc.lastSha,
    }))
    .sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));

  // Bus factor: how many of the top authors it takes to own more than half.
  let busFactor = 0;
  let accLines = 0;
  for (const author of authors) {
    busFactor++;
    accLines += author.lines;
    if (accLines * 2 > attributed) break;
  }

  return {
    totalLines: total,
    attributedLines: attributed,
    olderLines: older,
    pendingLines: pending,
    authors,
    busFactor,
    latest,
  };
}

/**
 * Picks the files under `folderPath` to blame for a folder ownership scan,
 * **largest first** so a cap keeps the files holding the most code (and so the
 * most ownership signal) rather than an arbitrary alphabetical slice. Size is
 * the only ranking signal available without a per-file request. `folderPath`
 * is '' for the repository root. Returns the capped selection, the total
 * number that matched (before the cap) and whether the cap dropped any.
 */
export function selectOwnershipFiles(
  entries: readonly TreeEntry[],
  folderPath: string,
  cap: number,
): { files: TreeEntry[]; capped: boolean; total: number } {
  const prefix = folderPath ? `${folderPath.replace(/\/+$/, '')}/` : '';
  const matching = entries
    .filter((e) => e.kind === 'file' && e.path.startsWith(prefix))
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0) || a.path.localeCompare(b.path));
  return { files: matching.slice(0, cap), capped: matching.length > cap, total: matching.length };
}

/** One file ranked by how much of its code has gone stale (old, untended knowledge). */
export interface FileRisk {
  readonly path: string;
  /** Lines with a known owning commit. */
  readonly attributedLines: number;
  /**
   * Σ over attributed lines of each line's staleness (0..1, an age ramp on when
   * the line was last edited) — a soft count of "aged" lines.
   */
  readonly staleLines: number;
  /** {@link staleLines} / {@link attributedLines}, 0..1 — how old the code is on average. */
  readonly staleShare: number;
  /**
   * Ranking key: {@link staleShare} × √{@link attributedLines}. Size counts, but
   * sub-linearly, so a small file of ancient code can outrank a big file of
   * recent code instead of sheer line count winning.
   */
  readonly riskScore: number;
  /** The author owning the most lines, and when they last touched them. */
  readonly owner: { readonly name: string; readonly lastAuthoredAt: string } | null;
}

/** A file plus its blame lines, the input to {@link computeOwnershipRisk}. */
export interface FileBlame {
  readonly path: string;
  readonly lines: Iterable<OwnedLine>;
}

/**
 * Ranks files by knowledge-loss risk straight from per-line blame. Each line is
 * weighted by its **staleness** — a 0..1 ramp on how long ago it was last edited
 * (½ at one {@link STALE_HALF_LIFE_DAYS} half-life) — so a line last touched a
 * decade ago weighs far more than one touched last year, and fresh code weighs
 * almost nothing. A file's {@link FileRisk.riskScore} is its *average* staleness
 * scaled by √(lines): size still matters, but sub-linearly, so a small file of
 * ancient code can outrank a large file of recent code rather than the biggest
 * file always winning. Pure and deterministic given `now`.
 */
export function computeOwnershipRisk(
  files: Iterable<FileBlame>,
  options: { now?: number; staleHalfLifeDays?: number } = {},
): readonly FileRisk[] {
  const now = options.now ?? Date.now();
  const halfLife = options.staleHalfLifeDays ?? STALE_HALF_LIFE_DAYS;

  const risks: FileRisk[] = [];
  for (const file of files) {
    let attributed = 0;
    let staleLines = 0;
    // Lines per author, to name the file's primary owner and when they last touched it.
    const byAuthor = new Map<string, { lines: number; lastTime: number; lastIso: string }>();
    for (const line of file.lines) {
      if (line === null || line === 'older') continue;
      const { authorName, authoredAt } = line.commit;
      const time = Date.parse(authoredAt);
      if (Number.isNaN(time)) continue; // undated blame: no basis to score staleness
      attributed++;
      const ageDays = Math.max(0, (now - time) / DAY_MS);
      staleLines += 1 - 2 ** (-ageDays / halfLife);
      const acc = byAuthor.get(authorName);
      if (acc) {
        acc.lines++;
        if (time > acc.lastTime) {
          acc.lastTime = time;
          acc.lastIso = authoredAt;
        }
      } else {
        byAuthor.set(authorName, { lines: 1, lastTime: time, lastIso: authoredAt });
      }
    }
    let owner: FileRisk['owner'] = null;
    let mostLines = 0;
    for (const [name, acc] of byAuthor) {
      if (acc.lines > mostLines) {
        mostLines = acc.lines;
        owner = { name, lastAuthoredAt: acc.lastIso };
      }
    }
    const staleShare = attributed > 0 ? staleLines / attributed : 0;
    risks.push({
      path: file.path,
      attributedLines: attributed,
      staleLines,
      staleShare,
      riskScore: staleShare * Math.sqrt(attributed),
      owner,
    });
  }

  return risks.sort(
    (a, b) =>
      b.riskScore - a.riskScore || b.staleShare - a.staleShare || a.path.localeCompare(b.path),
  );
}
