/**
 * Temporal coupling ("files that change together") from a window of commits —
 * the heart of the Insights view, in the spirit of Adam Tornhill's
 * change-coupling analysis (*Your Code as a Crime Scene*).
 *
 * Two files are coupled when they tend to change in the same commit. We count
 * how often each file changes and how often each pair changes together, then
 * rank pairs by a confidence-weighted coupling strength — a Wilson lower bound
 * on the Jaccard "degree", so a high ratio backed by little evidence (e.g. 100%
 * from two commits) is discounted below a well-supported one — and answer
 * "what's related to X?" by the share of X's commits that also touched the other
 * file. Commits that touch a great many files (sweeping refactors, merges,
 * formatters) are dropped, since they couple everything to everything.
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
  /** Coupled pairs with support ≥ `minSupport`, by confidence-weighted strength (strongest first). */
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

/**
 * Confidence-weighted coupling strength: the Wilson score lower bound of the
 * coupling proportion — of the `union` commits that touched either file,
 * `support` touched both. It rewards a high coupling ratio but discounts it when
 * the evidence is thin, so a perfect "100% from two commits" pair ranks below a
 * well-supported 65% one. `z` is the confidence multiplier (1.96 ≈ 95%); a wider
 * `z` penalises small samples harder. Returns 0 for an empty union. Pure.
 */
export function couplingConfidence(support: number, union: number, z = 1.96): number {
  if (union <= 0) return 0;
  const p = support / union;
  const z2 = z * z;
  const centre = p + z2 / (2 * union);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * union)) / union);
  return Math.max(0, (centre - margin) / (1 + z2 / union));
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

  const scored: { pair: CoChangePair; strength: number }[] = [];
  for (const { a, b, support } of pairCounts.values()) {
    if (support < minSupport) continue;
    const union = (changes.get(a) ?? 0) + (changes.get(b) ?? 0) - support;
    scored.push({
      pair: { a, b, support, degree: union > 0 ? support / union : 0 },
      strength: couplingConfidence(support, union),
    });
  }
  // Rank by confidence-weighted strength so a strong-but-flimsy pair (a high %
  // backed by few commits) sits below a well-evidenced one, then by raw support,
  // then by name for a stable order.
  scored.sort(
    (x, y) =>
      y.strength - x.strength ||
      y.pair.support - x.pair.support ||
      x.pair.a.localeCompare(y.pair.a) ||
      x.pair.b.localeCompare(y.pair.b),
  );

  return { commitsUsed, changes, pairs: scored.map((s) => s.pair) };
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

/** A connected group of files that change together. */
export interface CoChangeCluster {
  /** Member files, sorted. */
  readonly files: readonly string[];
  /** The couplings holding the cluster together. */
  readonly edges: readonly CoChangePair[];
  /** Total co-change support within the cluster — its strength. */
  readonly score: number;
}

const DEFAULT_MIN_DEGREE = 0.3;
const DEFAULT_CLUSTER_LIMIT = 10;
/** Bigger components are "super-clusters" (e.g. every package.json) — too tangled to read. */
const DEFAULT_CLUSTER_MAX_FILES = 8;

/**
 * Groups coupled files into clusters: keeps the couplings at or above
 * `minDegree` (so weak transitive links don't merge everything), then finds the
 * connected components. Only components with `minFiles`..`maxFiles` members are
 * kept — smaller ones are just pairs, bigger ones are unreadable hairballs.
 * Clusters come back strongest (most internal support) first, capped at `limit`.
 */
export function clusterCoChange(
  pairs: readonly CoChangePair[],
  options: { minDegree?: number; limit?: number; minFiles?: number; maxFiles?: number } = {},
): CoChangeCluster[] {
  const minDegree = options.minDegree ?? DEFAULT_MIN_DEGREE;
  const limit = options.limit ?? DEFAULT_CLUSTER_LIMIT;
  const minFiles = options.minFiles ?? 1;
  const maxFiles = options.maxFiles ?? DEFAULT_CLUSTER_MAX_FILES;
  const edges = pairs.filter((p) => p.degree >= minDegree);

  // Union-find over the files joined by the surviving edges.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const add = (x: string): void => {
    if (!parent.has(x)) parent.set(x, x);
  };
  for (const edge of edges) {
    add(edge.a);
    add(edge.b);
    parent.set(find(edge.a), find(edge.b));
  }

  const filesByRoot = new Map<string, Set<string>>();
  const edgesByRoot = new Map<string, CoChangePair[]>();
  for (const edge of edges) {
    const root = find(edge.a);
    let files = filesByRoot.get(root);
    if (!files) filesByRoot.set(root, (files = new Set()));
    files.add(edge.a);
    files.add(edge.b);
    let group = edgesByRoot.get(root);
    if (!group) edgesByRoot.set(root, (group = []));
    group.push(edge);
  }

  const clusters: CoChangeCluster[] = [];
  for (const [root, files] of filesByRoot) {
    if (files.size < minFiles || files.size > maxFiles) continue; // skip pairs & hairballs
    const clusterEdges = edgesByRoot.get(root) ?? [];
    clusters.push({
      files: [...files].sort(),
      edges: clusterEdges,
      score: clusterEdges.reduce((sum, edge) => sum + edge.support, 0),
    });
  }
  clusters.sort((a, b) => b.score - a.score || b.files.length - a.files.length);
  return clusters.slice(0, limit);
}

/** A coupling whose two files sit far apart in the directory tree. */
export interface SurprisingPair extends CoChangePair {
  /** Tree distance of the paths: 0 = same folder … 1 = nothing in common. */
  readonly distance: number;
}

/** Below this path distance a coupling is "expected" (same/near folder). */
const DEFAULT_MIN_DISTANCE = 0.5;

/**
 * Strongly-coupled pairs whose files live far apart in the tree — the
 * couplings most worth a second look. Nearby files changing together is
 * expected; a strong tie between distant parts of the codebase hints at a
 * hidden dependency or a leaky abstraction. Ranked by coupling degree weighted
 * by tree distance, keeping only pairs at or beyond `minDistance`. Pure.
 */
export function surprisingCouplings(
  pairs: readonly CoChangePair[],
  options: { limit?: number; minDistance?: number } = {},
): SurprisingPair[] {
  const limit = options.limit ?? 8;
  const minDistance = options.minDistance ?? DEFAULT_MIN_DISTANCE;
  const surprising: SurprisingPair[] = [];
  for (const pair of pairs) {
    const distance = pathDistance(pair.a, pair.b);
    if (distance >= minDistance) surprising.push({ ...pair, distance });
  }
  surprising.sort(
    (x, y) =>
      y.degree * y.distance - x.degree * x.distance ||
      y.support - x.support ||
      x.a.localeCompare(y.a) ||
      x.b.localeCompare(y.b),
  );
  return surprising.slice(0, limit);
}

/**
 * Directory distance between two file paths, 0 (same folder) to 1 (no shared
 * directory). Compares only the folder segments — a Sørensen-style ratio of
 * shared leading directories to total directory depth — so two files in the
 * same folder are 0 and two under unrelated top-level folders are 1.
 */
export function pathDistance(a: string, b: string): number {
  const dirsA = a.split('/').slice(0, -1);
  const dirsB = b.split('/').slice(0, -1);
  const total = dirsA.length + dirsB.length;
  if (total === 0) return 0; // both at the repository root
  const max = Math.min(dirsA.length, dirsB.length);
  let common = 0;
  while (common < max && dirsA[common] === dirsB[common]) common++;
  return 1 - (2 * common) / total;
}
