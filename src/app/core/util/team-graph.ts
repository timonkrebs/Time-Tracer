/**
 * Developer collaboration graph ("who works with whom") from a window of
 * commits — a social network inferred from shared file authorship.
 *
 * Two developers collaborate when they edit the same files: the more files they
 * have both touched, the stronger the tie. Aggregated across a commit window
 * this surfaces who works together, who bridges otherwise separate groups, and
 * who works in isolation (silos). It is the people-shaped twin of the file
 * change-coupling analysis (`co-change.ts`): where co-change asks "what changes
 * together", this asks "who changes the same things".
 *
 * Pure and deterministic, so it stays decoupled from the store and easy to
 * test; the store feeds it the very commits it already walked for co-change.
 */

/** A commit reduced to its author and the files it changed. */
export interface AuthoredCommit {
  readonly authorName: string;
  readonly files: readonly string[];
}

/** One developer — a node in the social graph. */
export interface Developer {
  readonly name: string;
  /** Commits authored across the analysed window. */
  readonly commits: number;
  /** Distinct files touched. */
  readonly files: number;
  /** Distinct collaborators (developers sharing ≥ 1 file). */
  readonly collaborators: number;
}

/** A collaboration tie between two developers who edit shared files — an edge. */
export interface Collaboration {
  readonly a: string;
  readonly b: string;
  /** Distinct files both developers have touched. */
  readonly sharedFiles: number;
  /** Jaccard overlap of their file sets, 0..1 — the tie's strength. */
  readonly strength: number;
}

export interface TeamGraph {
  /** Developers, most commits first. */
  readonly developers: readonly Developer[];
  /** Collaboration ties, strongest first. */
  readonly collaborations: readonly Collaboration[];
  /**
   * Connected groups of developers joined (directly or transitively) by shared
   * files — the "teams" the work splits into. Largest first; a lone developer
   * forms a group of one. More than one group means the work is siloed.
   */
  readonly components: readonly (readonly string[])[];
  /** Developers who share no files with anyone — working in isolation. */
  readonly silos: readonly string[];
}

export interface TeamGraphOptions {
  /** Drop commits touching more than this many files (sweeps, merges, formatters). */
  readonly maxCommitFiles?: number;
  /** Fewest shared files for two developers to count as collaborating. */
  readonly minShared?: number;
}

const DEFAULT_MAX_COMMIT_FILES = 25;
const DEFAULT_MIN_SHARED = 1;

/** The zero value: an empty graph, for windows with nothing to analyse. */
export const EMPTY_TEAM_GRAPH: TeamGraph = {
  developers: [],
  collaborations: [],
  components: [],
  silos: [],
};

interface PairAccum {
  a: string;
  b: string;
  shared: number;
}

/**
 * Builds the {@link TeamGraph} from a stream of authored commits: tallies each
 * author's commits and the set of files they touched, then ties two developers
 * by how many files they have both edited (Jaccard strength). Like the
 * co-change analysis, commits touching more than `maxCommitFiles` files
 * (sweeping refactors, merges, formatter runs) are dropped, so they don't
 * couple the whole team through one mechanical change.
 */
export function computeTeamGraph(
  commits: Iterable<AuthoredCommit>,
  options: TeamGraphOptions = {},
): TeamGraph {
  const maxCommitFiles = options.maxCommitFiles ?? DEFAULT_MAX_COMMIT_FILES;
  const minShared = options.minShared ?? DEFAULT_MIN_SHARED;

  const commitCount = new Map<string, number>();
  const filesByAuthor = new Map<string, Set<string>>();
  const authorsByFile = new Map<string, Set<string>>();

  for (const commit of commits) {
    const author = commit.authorName?.trim();
    const files = [...new Set(commit.files)];
    if (!author || files.length === 0 || files.length > maxCommitFiles) continue;
    commitCount.set(author, (commitCount.get(author) ?? 0) + 1);
    let owned = filesByAuthor.get(author);
    if (!owned) filesByAuthor.set(author, (owned = new Set()));
    for (const file of files) {
      owned.add(file);
      let authors = authorsByFile.get(file);
      if (!authors) authorsByFile.set(file, (authors = new Set()));
      authors.add(author);
    }
  }

  // Count shared files per unordered author pair, from each file's author set.
  // Keyed by "a\nb" (a git author name never contains a newline); a/b are kept
  // on the value so the key is never split.
  const pairs = new Map<string, PairAccum>();
  for (const authors of authorsByFile.values()) {
    if (authors.size < 2) continue;
    const list = [...authors].sort();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = list[i] + '\n' + list[j];
        const entry = pairs.get(key);
        if (entry) entry.shared++;
        else pairs.set(key, { a: list[i], b: list[j], shared: 1 });
      }
    }
  }

  const collaborations: Collaboration[] = [];
  const degree = new Map<string, number>();
  for (const { a, b, shared } of pairs.values()) {
    if (shared < minShared) continue;
    const union = (filesByAuthor.get(a)?.size ?? 0) + (filesByAuthor.get(b)?.size ?? 0) - shared;
    collaborations.push({ a, b, sharedFiles: shared, strength: union > 0 ? shared / union : 0 });
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
  }
  collaborations.sort(
    (x, y) =>
      y.sharedFiles - x.sharedFiles ||
      y.strength - x.strength ||
      x.a.localeCompare(y.a) ||
      x.b.localeCompare(y.b),
  );

  const developers: Developer[] = [...commitCount.entries()]
    .map(([name, commits]) => ({
      name,
      commits,
      files: filesByAuthor.get(name)?.size ?? 0,
      collaborators: degree.get(name) ?? 0,
    }))
    .sort((a, b) => b.commits - a.commits || b.files - a.files || a.name.localeCompare(b.name));

  const components = connectedComponents(
    developers.map((d) => d.name),
    collaborations,
  );
  const silos = developers.filter((d) => (degree.get(d.name) ?? 0) === 0).map((d) => d.name);

  return { developers, collaborations, components, silos };
}

/** One collaborator of a queried developer. */
export interface Collaborator {
  readonly name: string;
  readonly sharedFiles: number;
  readonly strength: number;
}

/** A developer's collaborators, most shared files first. */
export function collaboratorsOf(
  graph: TeamGraph,
  name: string,
  limit = Number.POSITIVE_INFINITY,
): Collaborator[] {
  const result: Collaborator[] = [];
  for (const edge of graph.collaborations) {
    const other = edge.a === name ? edge.b : edge.b === name ? edge.a : null;
    if (other === null) continue;
    result.push({ name: other, sharedFiles: edge.sharedFiles, strength: edge.strength });
  }
  result.sort(
    (x, y) =>
      y.sharedFiles - x.sharedFiles || y.strength - x.strength || x.name.localeCompare(y.name),
  );
  return Number.isFinite(limit) ? result.slice(0, limit) : result;
}

/** Connected components over the collaboration edges, via union-find. */
function connectedComponents(
  names: readonly string[],
  edges: readonly Collaboration[],
): string[][] {
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
  for (const name of names) parent.set(name, name);
  for (const edge of edges) {
    if (!parent.has(edge.a) || !parent.has(edge.b)) continue;
    parent.set(find(edge.a), find(edge.b));
  }

  const groups = new Map<string, string[]>();
  for (const name of names) {
    const root = find(name);
    let group = groups.get(root);
    if (!group) groups.set(root, (group = []));
    group.push(name);
  }
  return [...groups.values()]
    .map((group) => group.sort())
    .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}
