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
 * Each tie carries two strengths: an all-time {@link Collaboration.strength}
 * (file-set Jaccard) and a {@link Collaboration.temporalStrength} that weights
 * each shared file by how *close together in time* the two edited it (a
 * handoff/pairing signal) and how *recently* that happened. Blending between
 * them — see {@link blendStrength} — turns "ever shared a file" into "currently
 * working together".
 *
 * Developers are keyed by a stable **identity** — the author's email when known,
 * else their name — so two people who happen to share a display name stay
 * distinct, and one person who commits under several names (but one email) stays
 * a single node. The most frequent name seen for an identity is its display
 * label.
 *
 * Pure and deterministic, so it stays decoupled from the store and easy to
 * test; the store feeds it the very commits it already walked for co-change.
 */

/** A commit reduced to its author and the files it changed. */
export interface AuthoredCommit {
  readonly authorName: string;
  /** Author email — the stable identity when present. */
  readonly authorEmail?: string | null;
  /** ISO 8601 author date — drives the temporal (proximity) weighting. */
  readonly authoredAt?: string;
  readonly files: readonly string[];
}

/** One developer — a node in the social graph. */
export interface Developer {
  /** Stable identity: the author's (lower-cased) email when known, else name. */
  readonly id: string;
  /** Display name — the most frequent name seen for this identity. */
  readonly name: string;
  /** Commits authored across the analysed window. */
  readonly commits: number;
  /** Distinct files touched. */
  readonly files: number;
  /** Distinct collaborators (developers sharing ≥ 1 file). */
  readonly collaborators: number;
}

/**
 * A collaboration tie between two developers who edit shared files — an edge.
 * `a`/`b` are developer identities (see {@link Developer.id}).
 */
export interface Collaboration {
  readonly a: string;
  readonly b: string;
  /** Distinct files both developers have touched. */
  readonly sharedFiles: number;
  /** All-time Jaccard overlap of their file sets, 0..1. */
  readonly strength: number;
  /**
   * Like {@link strength}, but each shared file is weighted by their best
   * handoff on it — how close in time the two edits were *and* how recently
   * (relative to the newest commit in the window) — so current, near-
   * simultaneous work scores high while old or far-apart ties fade. 0..1,
   * always ≤ {@link strength}.
   */
  readonly temporalStrength: number;
}

export interface TeamGraph {
  /** Developers, most commits first. */
  readonly developers: readonly Developer[];
  /** Collaboration ties, strongest first. */
  readonly collaborations: readonly Collaboration[];
  /**
   * Connected groups of developer identities joined (directly or transitively)
   * by shared files — the "teams" the work splits into. Largest first; a lone
   * developer forms a group of one. More than one group means the work is
   * siloed.
   */
  readonly components: readonly (readonly string[])[];
  /** Identities of developers who share no files with anyone — working in isolation. */
  readonly silos: readonly string[];
}

export interface TeamGraphOptions {
  /** Drop commits touching more than this many files (sweeps, merges, formatters). */
  readonly maxCommitFiles?: number;
  /** Fewest shared files for two developers to count as collaborating. */
  readonly minShared?: number;
  /**
   * Half-life (days) of the temporal proximity decay: two edits this far apart
   * count half as much toward {@link Collaboration.temporalStrength} as
   * simultaneous ones.
   */
  readonly proximityHalfLifeDays?: number;
  /**
   * Half-life (days) of the age decay: a handoff this long before the newest
   * commit in the window counts half as much as one at the tip, so old
   * collaboration fades even when its two edits were close together.
   */
  readonly recencyHalfLifeDays?: number;
}

const DEFAULT_MAX_COMMIT_FILES = 25;
const DEFAULT_MIN_SHARED = 1;
const DEFAULT_PROXIMITY_HALF_LIFE_DAYS = 30;
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 90;
const DAY_MS = 86_400_000;

/** The zero value: an empty graph, for windows with nothing to analyse. */
export const EMPTY_TEAM_GRAPH: TeamGraph = {
  developers: [],
  collaborations: [],
  components: [],
  silos: [],
};

/**
 * Blends a tie's all-time and temporal strengths: `weight` 0 returns the
 * all-time strength, 1 the temporal one, values between interpolate. Because
 * both strengths share a denominator this is exact, not an approximation.
 */
export function blendStrength(strength: number, temporalStrength: number, weight: number): number {
  return strength + (temporalStrength - strength) * weight;
}

interface PairAccum {
  a: string;
  b: string;
  shared: number;
  temporal: number;
}

/** The stable identity and a display name for a commit's author, or null. */
function identityOf(commit: AuthoredCommit): { id: string; name: string } | null {
  const email = commit.authorEmail?.trim().toLowerCase() ?? '';
  const name = commit.authorName?.trim() ?? '';
  const id = email || name;
  if (!id) return null;
  // Prefer the human name as the label; fall back to the email's local part.
  const display = name || (email ? email.slice(0, email.indexOf('@')) || email : id);
  return { id, name: display };
}

/** The most-voted name for an identity, ties broken alphabetically. */
function pickName(votes: Map<string, number> | undefined): string {
  let best = '';
  let bestCount = -1;
  if (votes) {
    for (const [name, count] of votes) {
      if (count > bestCount || (count === bestCount && name.localeCompare(best) < 0)) {
        best = name;
        bestCount = count;
      }
    }
  }
  return best;
}

/**
 * Closeness in 0..1 of the best **handoff** between A and B on a shared file:
 * the strongest cross-edit pair, scored by how close together the two edits
 * were (proximity) *and* how recently the later of them landed relative to
 * `latest`, the newest commit in the window (age). 1 for a same-moment handoff
 * at the tip, decaying with both the gap and the age. Zero when either side has
 * no dated edit.
 */
function temporalCloseness(
  timesA: readonly number[],
  timesB: readonly number[],
  latest: number,
  proximityHalfLifeMs: number,
  recencyHalfLifeMs: number,
): number {
  let best = 0;
  for (const ta of timesA) {
    for (const tb of timesB) {
      const proximityScore = 2 ** (-Math.abs(ta - tb) / proximityHalfLifeMs);
      const ageScore = 2 ** (-(latest - Math.max(ta, tb)) / recencyHalfLifeMs);
      const score = proximityScore * ageScore;
      if (score > best) best = score;
    }
  }
  return best;
}

/**
 * Builds the {@link TeamGraph} from a stream of authored commits: tallies each
 * author's commits and the set of files they touched (keyed by identity), then
 * ties two developers by how many files they have both edited (Jaccard
 * strength) and by how close in time — and how recently — those edits were
 * (temporal strength). Like
 * the co-change analysis, commits touching more than `maxCommitFiles` files
 * (sweeping refactors, merges, formatter runs) are dropped, so they don't
 * couple the whole team through one mechanical change.
 */
export function computeTeamGraph(
  commits: Iterable<AuthoredCommit>,
  options: TeamGraphOptions = {},
): TeamGraph {
  const maxCommitFiles = options.maxCommitFiles ?? DEFAULT_MAX_COMMIT_FILES;
  const minShared = options.minShared ?? DEFAULT_MIN_SHARED;
  const proximityHalfLifeMs =
    (options.proximityHalfLifeDays ?? DEFAULT_PROXIMITY_HALF_LIFE_DAYS) * DAY_MS;
  const recencyHalfLifeMs =
    (options.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS) * DAY_MS;

  const commitCount = new Map<string, number>();
  const filesByAuthor = new Map<string, Set<string>>();
  /** Per file, the edit timestamps of each author who touched it. */
  const editsByFile = new Map<string, Map<string, number[]>>();
  /** Name → count per identity, to resolve a display name for split identities. */
  const nameVotes = new Map<string, Map<string, number>>();
  /** Newest commit timestamp seen — the reference point for the age decay. */
  let latest = -Infinity;

  for (const commit of commits) {
    const identity = identityOf(commit);
    const files = [...new Set(commit.files)];
    if (!identity || files.length === 0 || files.length > maxCommitFiles) continue;
    const { id, name } = identity;
    const time = commit.authoredAt ? Date.parse(commit.authoredAt) : NaN;
    if (!Number.isNaN(time) && time > latest) latest = time;
    commitCount.set(id, (commitCount.get(id) ?? 0) + 1);
    let votes = nameVotes.get(id);
    if (!votes) nameVotes.set(id, (votes = new Map()));
    votes.set(name, (votes.get(name) ?? 0) + 1);
    let owned = filesByAuthor.get(id);
    if (!owned) filesByAuthor.set(id, (owned = new Set()));
    for (const file of files) {
      owned.add(file);
      let perAuthor = editsByFile.get(file);
      if (!perAuthor) editsByFile.set(file, (perAuthor = new Map()));
      let times = perAuthor.get(id);
      if (!times) perAuthor.set(id, (times = []));
      if (!Number.isNaN(time)) times.push(time);
    }
  }

  // Per file, accumulate each unordered identity pair: +1 shared, plus the
  // temporal closeness of their best handoff (proximity × age). Keyed by "a\nb"
  // (an identity never contains a newline); a/b are kept on the value so the key
  // isn't split.
  const pairs = new Map<string, PairAccum>();
  for (const perAuthor of editsByFile.values()) {
    if (perAuthor.size < 2) continue;
    const ids = [...perAuthor.keys()].sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const closeness = temporalCloseness(
          perAuthor.get(ids[i])!,
          perAuthor.get(ids[j])!,
          latest,
          proximityHalfLifeMs,
          recencyHalfLifeMs,
        );
        const key = ids[i] + '\n' + ids[j];
        const entry = pairs.get(key);
        if (entry) {
          entry.shared++;
          entry.temporal += closeness;
        } else {
          pairs.set(key, { a: ids[i], b: ids[j], shared: 1, temporal: closeness });
        }
      }
    }
  }

  const collaborations: Collaboration[] = [];
  const degree = new Map<string, number>();
  for (const { a, b, shared, temporal } of pairs.values()) {
    if (shared < minShared) continue;
    const union = (filesByAuthor.get(a)?.size ?? 0) + (filesByAuthor.get(b)?.size ?? 0) - shared;
    collaborations.push({
      a,
      b,
      sharedFiles: shared,
      strength: union > 0 ? shared / union : 0,
      temporalStrength: union > 0 ? temporal / union : 0,
    });
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
    .map(([id, commits]) => ({
      id,
      name: pickName(nameVotes.get(id)),
      commits,
      files: filesByAuthor.get(id)?.size ?? 0,
      collaborators: degree.get(id) ?? 0,
    }))
    .sort(
      (a, b) =>
        b.commits - a.commits ||
        b.files - a.files ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );

  const components = connectedComponents(
    developers.map((d) => d.id),
    collaborations,
  );
  const silos = developers.filter((d) => (degree.get(d.id) ?? 0) === 0).map((d) => d.id);

  return { developers, collaborations, components, silos };
}

/** One collaborator of a queried developer. */
export interface Collaborator {
  readonly id: string;
  readonly name: string;
  readonly sharedFiles: number;
  readonly strength: number;
  readonly temporalStrength: number;
}

/**
 * A developer's collaborators (by identity), most shared files first. Ties on
 * shared-file count are broken by blended strength at `temporalWeight` (0 =
 * all-time, 1 = temporal), so the ordering follows the active slider.
 */
export function collaboratorsOf(
  graph: TeamGraph,
  id: string,
  limit = Number.POSITIVE_INFINITY,
  temporalWeight = 0,
): Collaborator[] {
  const nameById = new Map(graph.developers.map((d) => [d.id, d.name]));
  const result: Collaborator[] = [];
  for (const edge of graph.collaborations) {
    const other = edge.a === id ? edge.b : edge.b === id ? edge.a : null;
    if (other === null) continue;
    result.push({
      id: other,
      name: nameById.get(other) ?? other,
      sharedFiles: edge.sharedFiles,
      strength: edge.strength,
      temporalStrength: edge.temporalStrength,
    });
  }
  result.sort(
    (x, y) =>
      y.sharedFiles - x.sharedFiles ||
      blendStrength(y.strength, y.temporalStrength, temporalWeight) -
        blendStrength(x.strength, x.temporalStrength, temporalWeight) ||
      x.name.localeCompare(y.name) ||
      x.id.localeCompare(y.id),
  );
  return Number.isFinite(limit) ? result.slice(0, limit) : result;
}

/** Connected components over the collaboration edges, via union-find. */
function connectedComponents(ids: readonly string[], edges: readonly Collaboration[]): string[][] {
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
  for (const id of ids) parent.set(id, id);
  for (const edge of edges) {
    if (!parent.has(edge.a) || !parent.has(edge.b)) continue;
    parent.set(find(edge.a), find(edge.b));
  }

  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    let group = groups.get(root);
    if (!group) groups.set(root, (group = []));
    group.push(id);
  }
  return [...groups.values()]
    .map((group) => group.sort())
    .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}
