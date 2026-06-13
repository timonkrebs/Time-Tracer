/**
 * Folds per-line blame attribution into an authorship summary — the data
 * behind the "who do I ask about this?" view.
 *
 * Works on anything shaped like a blame line (so it stays decoupled from the
 * store): an owning commit, the `'older'` marker for lines that predate the
 * loaded history, or `null` for lines still being attributed.
 */

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
