/**
 * Temporal coupling ("files that change together") from a window of commits —
 * the heart of the Insights view, in the spirit of Adam Tornhill's
 * change-coupling analysis (*Your Code as a Crime Scene*).
 *
 * Two files are coupled when they tend to change in the same commit. We count
 * how often each file changes and how often each pair changes together, then
 * score pairs by a Jaccard "degree" and answer "what's related to X?" by the
 * share of X's commits that also touched the other file. Commits that touch a
 * great many files (sweeping refactors, merges, formatters) are dropped, since
 * they couple everything to everything.
 *
 * Pure and deterministic, so it stays decoupled from the store and is easy to
 * test; the store feeds it commits it has already walked.
 */

/** A commit reduced to the set of files it changed. */
export interface CommitFiles {
  readonly sha: string;
  readonly files: readonly string[];
}

/** One pair of files that change together. */
export interface CoChangePair {
  readonly a: string;
  readonly b: string;
  /** Commits in which both files changed. */
  readonly support: number;
  /** Jaccard coupling: support / (changes(a) + changes(b) − support), 0..1. */
  readonly degree: number;
}

/** A file coupled to a queried file. */
export interface RelatedFile {
  readonly path: string;
  readonly support: number;
  /** Of the commits that changed the queried file, the share that also changed this one. */
  readonly confidence: number;
}

export interface CoChangeResult {
  /** Commits that counted (after dropping over-large ones). */
  readonly commitsUsed: number;
  /** Per-file change counts across the counted commits. */
  readonly changes: ReadonlyMap<string, number>;
  /** Coupled pairs with support ≥ `minSupport`, strongest first. */
  readonly pairs: readonly CoChangePair[];
}

export interface CoChangeOptions {
  /** Drop commits touching more than this many files (they add noise). */
  readonly maxCommitFiles?: number;
  /** Fewest co-change commits for a pair to count as coupled. */
  readonly minSupport?: number;
}

const DEFAULT_MAX_COMMIT_FILES = 25;
const DEFAULT_MIN_SUPPORT = 2;

interface PairAccum {
  a: string;
  b: string;
  support: number;
}

/** Aggregates commit file-sets into change counts and ranked coupled pairs. */
export function computeCoChange(
  commits: Iterable<CommitFiles>,
  options: CoChangeOptions = {},
): CoChangeResult {
  const maxCommitFiles = options.maxCommitFiles ?? DEFAULT_MAX_COMMIT_FILES;
  const minSupport = options.minSupport ?? DEFAULT_MIN_SUPPORT;

  const changes = new Map<string, number>();
  // Keyed by "a\nb" (git paths never contain a newline); the value keeps a/b so
  // we never split a key that might contain awkward characters.
  const pairCounts = new Map<string, PairAccum>();
  let commitsUsed = 0;

  for (const commit of commits) {
    const files = [...new Set(commit.files)].sort();
    if (files.length === 0 || files.length > maxCommitFiles) continue;
    commitsUsed++;
    for (const file of files) changes.set(file, (changes.get(file) ?? 0) + 1);
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = files[i] + '\n' + files[j];
        const entry = pairCounts.get(key);
        if (entry) entry.support++;
        else pairCounts.set(key, { a: files[i], b: files[j], support: 1 });
      }
    }
  }

  const pairs: CoChangePair[] = [];
  for (const { a, b, support } of pairCounts.values()) {
    if (support < minSupport) continue;
    const union = (changes.get(a) ?? 0) + (changes.get(b) ?? 0) - support;
    pairs.push({ a, b, support, degree: union > 0 ? support / union : 0 });
  }
  pairs.sort(
    (x, y) =>
      y.support - x.support ||
      y.degree - x.degree ||
      x.a.localeCompare(y.a) ||
      x.b.localeCompare(y.b),
  );

  return { commitsUsed, changes, pairs };
}

/** Files most coupled to `path`, by how often they rode along with its changes. */
export function relatedFiles(result: CoChangeResult, path: string, limit = 8): RelatedFile[] {
  const total = result.changes.get(path) ?? 0;
  if (total === 0) return [];
  const related: RelatedFile[] = [];
  for (const pair of result.pairs) {
    const other = pair.a === path ? pair.b : pair.b === path ? pair.a : null;
    if (other === null) continue;
    related.push({ path: other, support: pair.support, confidence: pair.support / total });
  }
  related.sort(
    (x, y) => y.confidence - x.confidence || y.support - x.support || x.path.localeCompare(y.path),
  );
  return related.slice(0, limit);
}
