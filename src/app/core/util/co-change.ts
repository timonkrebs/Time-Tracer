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

/**
 * The "module" a file belongs to: its directory prefix at `depth` segments.
 * `src/auth/login.ts` → `src` at depth 1, `src/auth` at depth 2; a file with
 * fewer directories than `depth` rolls up to its own folder, and a file at the
 * repository root has no module (''). Modules are how change coupling is rolled
 * up from files to the architecture level.
 */
export function moduleOf(path: string, depth: number): string {
  const slash = path.lastIndexOf('/');
  if (slash < 0) return ''; // a file at the repository root
  const dir = path.slice(0, slash);
  if (depth <= 0) return dir;
  return dir.split('/').slice(0, depth).join('/');
}

/**
 * Change coupling rolled up to **modules** (directory prefixes at `depth`):
 * which parts of the tree change together. Each commit's files collapse to the
 * set of modules they live in, so a commit touching two files in the same
 * folder couples nothing, while one spanning `auth/` and `ui/` couples those
 * modules — surfacing cross-boundary entanglement (the architectural-decay
 * smell) and hiding the within-module churn that is expected.
 *
 * Sweeps are dropped by their real file count *before* the roll-up (a 50-file
 * refactor stays noise even if it spans only three folders), then the same
 * pairing and scoring as {@link computeCoChange} runs over the modules.
 */
export function computeModuleCoChange(
  commits: Iterable<CommitFiles>,
  options: { depth?: number; maxCommitFiles?: number; minSupport?: number } = {},
): CoChangeResult {
  const depth = options.depth ?? 1;
  const maxCommitFiles = options.maxCommitFiles ?? DEFAULT_MAX_COMMIT_FILES;
  const moduleCommits: CommitFiles[] = [];
  for (const commit of commits) {
    const files = [...new Set(commit.files)];
    // Filter sweeps by the actual files touched, not the (smaller) module count.
    if (files.length === 0 || files.length > maxCommitFiles) continue;
    const modules = new Set<string>();
    for (const file of files) modules.add(moduleOf(file, depth));
    moduleCommits.push({ sha: commit.sha, files: [...modules] });
  }
  // Sweep filtering is already done, so don't re-cap on the module count.
  return computeCoChange(moduleCommits, {
    minSupport: options.minSupport,
    maxCommitFiles: Number.POSITIVE_INFINITY,
  });
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
