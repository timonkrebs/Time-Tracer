/**
 * Knowledge-loss / turnover risk from a window of commits — the data behind the
 * Insights "Knowledge" tab.
 *
 * Hotspots say *what* churns and coupling says *what moves together*; this says
 * *who holds the knowledge — and whether they are still around*. For each file
 * we fold the commits that touched it into a recency-weighted **authored
 * knowledge** share per contributor (fresh edits weigh more, in the same spirit
 * as {@link computeFileMetric}), then ask how much of that knowledge belongs to
 * contributors who have gone quiet. A file whose experts have left is a
 * knowledge black box waiting to happen.
 *
 * Honest about its limits: "knowledge" here is *authored* knowledge only
 * (commits — not reviews or reading), and "gone" is inferred purely from commit
 * silence within the analysed window, never asserted. A capped walk can mistake
 * an active contributor for a departed one, so the model carries a `partial`
 * flag the UI surfaces.
 *
 * Pure and deterministic given `now`, so it stays decoupled from the store and
 * is easy to test; the store feeds it the same commits it already walks for
 * hotspots and coupling.
 */

import { DEFAULT_HALF_LIFE_DAYS } from './hotspots';

/** A commit reduced to the fields the knowledge model needs. */
export interface KnowledgeCommit {
  readonly authorName: string;
  /** ISO 8601 author date. */
  readonly authoredAt: string;
  readonly files: readonly string[];
  /** Lines removed across the commit's files, when the provider reports them. */
  readonly deletions?: number;
}

/** A contributor's presence across the analysed history. */
export interface AuthorPresence {
  readonly name: string;
  /** Commits authored (bots excluded; sweeps and empty commits still count). */
  readonly commits: number;
  /** Total lines removed across all their commits (the "code eliminator" stat). */
  readonly deletions: number;
  /** Recency-weighted authoring of real files — their "live" knowledge. */
  readonly knowledge: number;
  /** ISO date of their most recent commit (any commit counts), or null when undated. */
  readonly lastActiveAt: string | null;
  /** True when they committed within one inactivity half-life. */
  readonly active: boolean;
  /**
   * Soft departure factor, 0..1: 0 just after a commit, ½ one inactivity
   * half-life of silence later, approaching 1 as the silence grows. A ramp,
   * not a cliff, so the risk score does not jump at an arbitrary threshold.
   */
  readonly departed: number;
}

/** One contributor's stake in a single file's authored knowledge. */
export interface FileExpert {
  readonly name: string;
  /** Fraction of the file's recency-weighted authored knowledge, 0..1. */
  readonly share: number;
  readonly lastActiveAt: string | null;
  readonly active: boolean;
}

/** A file ranked by how much of its authored knowledge has left the project. */
export interface KnowledgeRisk {
  readonly path: string;
  /** Size in bytes (a stand-in for LOC), driving the treemap rectangle. */
  readonly size: number;
  /**
   * Recency-weighted authoring activity for the file (its hotspot score).
   * Informational only — the risk ranking weights by {@link size}, not recency,
   * so a dormant-but-orphaned file is not pushed down for having gone quiet.
   */
  readonly weight: number;
  /** Contributors with a stake in the file, largest share first. */
  readonly experts: readonly FileExpert[];
  /** The largest-share contributor, or null when the file has no dated commits. */
  readonly primaryExpert: FileExpert | null;
  /** Fewest top contributors whose combined knowledge exceeds half the file. */
  readonly busFactor: number;
  /**
   * Share of the file's knowledge held by contributors who have gone quiet,
   * 0..1 (each expert's share weighted by their {@link AuthorPresence.departed}
   * factor). The headline risk metric: 1 means everyone who knows this file is
   * gone.
   */
  readonly orphanedShare: number;
  /** Ranking key: {@link size} × {@link orphanedShare} — how much code has gone quiet. */
  readonly riskScore: number;
  /** True when the underlying walk may be missing older history. */
  readonly partial: boolean;
}

export interface KnowledgeModel {
  /** Commits that counted (after dropping bots and over-large ones). */
  readonly commitsUsed: number;
  /** Contributors, by recency-weighted knowledge then commits then name. */
  readonly authors: readonly AuthorPresence[];
  /** Files, most knowledge-loss risk first. */
  readonly files: readonly KnowledgeRisk[];
  /** True when the walk may be missing older history (a capped analysis). */
  readonly partial: boolean;
}

const DAY_MS = 86_400_000;
const DEFAULT_MAX_COMMIT_FILES = 25;

/**
 * Default inactivity half-life, in days. With ~120 days a contributor silent
 * for four months counts as half-departed, and one silent for that long is no
 * longer "active" — a reasonable line between "between tasks" and "moved on"
 * for an actively developed repository.
 */
export const DEFAULT_INACTIVITY_HALF_LIFE_DAYS = 120;

/**
 * Matches automated authors (CI, dependency bots) so they are not mistaken for
 * human experts. Anchored to keep false positives out ("Abbot", "robot" do not
 * match). Callers can override via `ignoreAuthor`.
 */
const BOT_PATTERN =
  /\[bot\]$|^(dependabot|renovate(-bot)?|greenkeeper|github-actions|semantic-release|snyk-bot|mergify|imgbot|allcontributors)(\[bot\])?$/i;

/** Whether an author name looks like an automated account. */
export function isBotAuthor(name: string): boolean {
  return BOT_PATTERN.test(name.trim());
}

/**
 * Lower-bound orphaned share for each risk level: level `n` covers shares from
 * `RISK_THRESHOLDS[n]` up to (but excluding) `RISK_THRESHOLDS[n + 1]`. Level 0
 * starts at 0, so every share maps to a level.
 */
export const RISK_THRESHOLDS: readonly [0, number, number, number, number] = [
  0, 0.25, 0.5, 0.75, 0.9,
];

/**
 * Buckets an {@link KnowledgeRisk.orphanedShare} into five risk levels
 * (0 = well-known … 4 = orphaned) for colour-coding, using {@link RISK_THRESHOLDS}.
 */
export function riskLevel(orphanedShare: number): 0 | 1 | 2 | 3 | 4 {
  for (let level = 4; level > 0; level--) {
    if (orphanedShare >= RISK_THRESHOLDS[level]) return level as 1 | 2 | 3 | 4;
  }
  return 0;
}

interface AuthorAcc {
  commits: number;
  deletions: number;
  knowledge: number;
  lastMs: number;
  lastIso: string | null;
}

/**
 * Folds commits into per-file knowledge-loss risk and per-author presence.
 *
 * For each commit we weight the authoring by recency (`2^(-ageDays/halfLife)`),
 * credit that weight to the author on every file the commit touched, and track
 * the author's most recent activity anywhere. A file's risk is the share of its
 * weighted knowledge held by contributors who have since gone quiet (its
 * orphaned share), scaled by the file's size so the most code at stake ranks
 * first. Importance is size, not recency: a large file abandoned long ago is
 * exactly the knowledge loss this surfaces, while an actively-maintained file
 * stays low-risk through its low orphaned share rather than being boosted for
 * being busy.
 *
 * Bots are dropped (see {@link isBotAuthor}). A commit grants no per-file
 * expertise when it touches more than `maxCommitFiles` (sweeps, merges,
 * formatters), no files at all (e.g. it touched only generated/vendored paths
 * the caller filtered out), or carries no parseable date — one refactor or
 * lockfile bump does not make its author an "expert", and undated authorship is
 * left out rather than shown as safely owned. Each still counts toward the
 * author's presence, so recent activity is not mistaken for going silent. Pure
 * and deterministic given `now`, so tests can pin the reference time.
 */
export function computeKnowledgeRisk(
  commits: Iterable<KnowledgeCommit>,
  sizes: ReadonlyMap<string, number>,
  options: {
    now?: number;
    halfLifeDays?: number;
    inactivityHalfLifeDays?: number;
    maxCommitFiles?: number;
    partial?: boolean;
    /** Override the bot filter (e.g. `() => false` to count every author). */
    ignoreAuthor?: (name: string) => boolean;
  } = {},
): KnowledgeModel {
  const now = options.now ?? Date.now();
  const halfLifeDays = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const inactivityHalfLifeDays =
    options.inactivityHalfLifeDays ?? DEFAULT_INACTIVITY_HALF_LIFE_DAYS;
  const maxCommitFiles = options.maxCommitFiles ?? DEFAULT_MAX_COMMIT_FILES;
  const ignore = options.ignoreAuthor ?? isBotAuthor;
  const partial = options.partial ?? false;

  const authorAcc = new Map<string, AuthorAcc>();
  // file -> (author -> recency-weighted knowledge), plus the file's total.
  const fileAuthors = new Map<string, Map<string, number>>();
  const fileWeight = new Map<string, number>();
  let commitsUsed = 0;

  for (const commit of commits) {
    const name = commit.authorName;
    if (!name || ignore(name)) continue;
    const files = [...new Set(commit.files)];

    const t = Date.parse(commit.authoredAt);
    const dated = !Number.isNaN(t);
    // Future-dated commits (clock skew) are clamped to weight 1.
    const ageDays = dated ? Math.max(0, (now - t) / DAY_MS) : 0;
    const weight = dated ? 2 ** (-ageDays / halfLifeDays) : 0;

    // A commit grants per-file expertise only when it touches a workable number
    // of real files *and* we can date it. A sweep (big merge, formatting pass,
    // license-header change) touches too many to mean expertise; a commit left
    // empty after generated/vendored files were filtered out upstream touches
    // none; and an undated commit (weight 0) would add a contributor at a 0%
    // share, making a file look safely owned when we have no basis to judge its
    // turnover. None grant per-file knowledge — but each is still a commit, so it
    // counts toward the author's presence (a recent sweep or lockfile bump means
    // they have *not* gone silent).
    const expertise = dated && files.length > 0 && files.length <= maxCommitFiles;

    const acc = authorAcc.get(name) ?? {
      commits: 0,
      deletions: 0,
      knowledge: 0,
      lastMs: -Infinity,
      lastIso: null,
    };
    acc.commits++;
    // Every commit's removed lines count toward the eliminator tally — sweeps
    // and big deletions included — independent of the per-file expertise gate.
    acc.deletions += Math.max(0, commit.deletions ?? 0);
    if (expertise) acc.knowledge += weight;
    if (dated && t > acc.lastMs) {
      acc.lastMs = t;
      acc.lastIso = commit.authoredAt;
    }
    authorAcc.set(name, acc);

    if (!expertise) continue;
    commitsUsed++;

    for (const file of files) {
      let byAuthor = fileAuthors.get(file);
      if (!byAuthor) fileAuthors.set(file, (byAuthor = new Map()));
      byAuthor.set(name, (byAuthor.get(name) ?? 0) + weight);
      fileWeight.set(file, (fileWeight.get(file) ?? 0) + weight);
    }
  }

  const presence = new Map<string, AuthorPresence>();
  for (const [name, acc] of authorAcc) {
    const inactiveDays =
      acc.lastMs === -Infinity ? Infinity : Math.max(0, (now - acc.lastMs) / DAY_MS);
    const departed = Number.isFinite(inactiveDays)
      ? 1 - 2 ** (-inactiveDays / inactivityHalfLifeDays)
      : 1;
    presence.set(name, {
      name,
      commits: acc.commits,
      deletions: acc.deletions,
      knowledge: acc.knowledge,
      lastActiveAt: acc.lastIso,
      active: inactiveDays < inactivityHalfLifeDays,
      departed,
    });
  }

  const authors = [...presence.values()].sort(
    (a, b) => b.knowledge - a.knowledge || b.commits - a.commits || a.name.localeCompare(b.name),
  );

  const files: KnowledgeRisk[] = [];
  for (const [path, byAuthor] of fileAuthors) {
    const total = fileWeight.get(path) ?? 0;
    const ranked = [...byAuthor.entries()]
      .map(([name, knowledge]) => ({ name, knowledge }))
      .sort((a, b) => b.knowledge - a.knowledge || a.name.localeCompare(b.name));

    const experts: FileExpert[] = ranked.map(({ name, knowledge }) => {
      const p = presence.get(name)!;
      return {
        name,
        share: total > 0 ? knowledge / total : 0,
        lastActiveAt: p.lastActiveAt,
        active: p.active,
      };
    });

    // Bus factor: top contributors needed to own more than half the knowledge.
    let busFactor = 0;
    let covered = 0;
    for (const { knowledge } of ranked) {
      busFactor++;
      covered += knowledge;
      if (total > 0 && covered * 2 > total) break;
    }

    let orphanedShare = 0;
    for (const expert of experts)
      orphanedShare += expert.share * presence.get(expert.name)!.departed;

    const size = sizes.get(path) ?? 0;
    files.push({
      path,
      size,
      weight: total,
      experts,
      primaryExpert: experts[0] ?? null,
      busFactor,
      orphanedShare,
      // Importance is the file's size (≈ amount of code at stake), not its
      // recent activity: a large file whose authors have all gone quiet is the
      // real knowledge loss, while an actively-maintained file stays low-risk
      // through its low orphaned share — so recency must not inflate the score.
      // Some providers (GitLab, Bitbucket Server) report no tree sizes; fall back
      // to a flat weight so the ranking degrades to orphaned share, not all-zero.
      riskScore: (size || 1) * orphanedShare,
      partial,
    });
  }
  files.sort(
    (a, b) =>
      b.riskScore - a.riskScore ||
      b.orphanedShare - a.orphanedShare ||
      a.path.localeCompare(b.path),
  );

  return { commitsUsed, authors, files, partial };
}
