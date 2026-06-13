import { CommitInfo } from '../models';

/**
 * Per-file change metrics derived from a file's commit history — the
 * data behind "hotspot" decorations in the file tree.
 *
 * The headline number is {@link FileMetric.score}: a recency-weighted change
 * frequency, in the spirit of Adam Tornhill's hotspots (and tools like
 * angular-architects/detective), but with newer commits counting for more so
 * a file that churned heavily last week outranks one that churned years ago.
 */
export interface FileMetric {
  /** Commits in the analysed history that touched the file. */
  readonly revisions: number;
  /**
   * Recency-weighted change score: Σ over commits of `2^(-ageDays/halfLife)`.
   * A commit made today contributes 1; one a half-life old contributes ½, and
   * so on. Higher means hotter (changes often, recently).
   */
  readonly score: number;
  /** ISO date of the most recent commit that touched the file, or null. */
  readonly lastChange: string | null;
  /** ISO date of the oldest *loaded* commit that touched the file, or null. */
  readonly firstChange: string | null;
  /** Distinct author names across the analysed history. */
  readonly authors: number;
  /**
   * True when older commits exist beyond the loaded history pages, so
   * {@link revisions} is a lower bound. The recency-weighted {@link score} is
   * barely affected (the unseen commits are the oldest and weigh the least).
   */
  readonly partial: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Default decay half-life, in days. With ~90 days a commit from a quarter ago
 * counts half as much as one made today — a reasonable sense of "recent" for
 * an actively developed repository.
 */
export const DEFAULT_HALF_LIFE_DAYS = 90;

/**
 * Computes the {@link FileMetric} for a file from the commits that touched it
 * (as returned by `git log -- <path>`, newest first — though order does not
 * matter here). Pure and deterministic given `now`, so callers in tests can
 * pin the reference time.
 *
 * Commits with an unparseable date are still counted as revisions but do not
 * contribute to the score or the first/last bounds; future-dated commits
 * (clock skew) are clamped to weight 1 rather than exceeding it.
 */
export function computeFileMetric(
  commits: readonly CommitInfo[],
  options: { now?: number; halfLifeDays?: number; partial?: boolean } = {},
): FileMetric {
  const now = options.now ?? Date.now();
  const halfLifeDays = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;

  let score = 0;
  let lastMs = -Infinity;
  let firstMs = Infinity;
  let lastChange: string | null = null;
  let firstChange: string | null = null;
  const authors = new Set<string>();

  for (const commit of commits) {
    if (commit.authorName) authors.add(commit.authorName);
    const t = Date.parse(commit.authoredAt);
    if (Number.isNaN(t)) continue;
    const ageDays = Math.max(0, (now - t) / DAY_MS);
    score += 2 ** (-ageDays / halfLifeDays);
    if (t > lastMs) {
      lastMs = t;
      lastChange = commit.authoredAt;
    }
    if (t < firstMs) {
      firstMs = t;
      firstChange = commit.authoredAt;
    }
  }

  return {
    revisions: commits.length,
    score,
    lastChange,
    firstChange,
    authors: authors.size,
    partial: options.partial ?? false,
  };
}

/**
 * Lower-bound score for each heat level: level `n` covers scores from
 * `HEAT_THRESHOLDS[n]` up to (but excluding) `HEAT_THRESHOLDS[n + 1]`. Level 0
 * starts at 0, so every non-negative score maps to a level.
 */
export const HEAT_THRESHOLDS: readonly [0, number, number, number, number] = [0, 0.75, 2, 4, 8];

/**
 * Buckets a recency-weighted {@link FileMetric.score} into five heat levels
 * (0 = cold … 4 = hot) for colour-coding, using {@link HEAT_THRESHOLDS}. The
 * thresholds read against the score's natural meaning — roughly the number of
 * "recent-equivalent" changes — so ~8+ recent changes is a hotspot.
 */
export function heatLevel(score: number): 0 | 1 | 2 | 3 | 4 {
  for (let level = 4; level > 0; level--) {
    if (score >= HEAT_THRESHOLDS[level]) return level as 1 | 2 | 3 | 4;
  }
  return 0;
}
