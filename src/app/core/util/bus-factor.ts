/**
 * Bus-factor analysis — "what happens to this code if a contributor leaves?".
 *
 * Builds straight on the {@link KnowledgeModel}: every file already carries its
 * ranked experts (with an `active` flag derived from commit silence), so the
 * question "which files would lose all their living knowledge if these people
 * left?" is a count over those experts. A file is **covered** while it has at
 * least one active expert; remove the people who hold it and it becomes
 * **orphaned**. Pure and deterministic — the UI owns the "who left" selection.
 */

import { KnowledgeModel } from './knowledge';

/** One contributor in the bus-factor leaderboard. */
export interface Contributor {
  readonly name: string;
  readonly commits: number;
  /** Recency-weighted authored knowledge (the file-share total). */
  readonly knowledge: number;
  /** Committed within one inactivity half-life. */
  readonly active: boolean;
  readonly lastActiveAt: string | null;
  /** Files where this author holds the largest knowledge share. */
  readonly filesOwned: number;
  /** Files that would be orphaned if this author alone left — their bus risk. */
  readonly busRisk: number;
}

/** The effect of a set of contributors leaving the project. */
export interface DepartureImpact {
  /** Files that currently have at least one expert (the denominator). */
  readonly filesWithExperts: number;
  /** Files already without an active expert — orphaned before anyone leaves. */
  readonly alreadyOrphaned: number;
  /** Files covered today that would be orphaned by the departure. */
  readonly newlyOrphaned: number;
  /** Total orphaned files after the departure. */
  readonly orphanedAfter: number;
  /** Paths newly orphaned by the departure (for highlighting), risk-ranked. */
  readonly newlyOrphanedPaths: readonly string[];
}

/**
 * Counts the files orphaned when everyone in `removed` leaves. A file is
 * covered while it has an active expert outside `removed`; one whose only
 * active experts are all leaving becomes newly orphaned. Files with no active
 * expert at all are counted as already orphaned, independent of `removed`.
 */
export function simulateDeparture(
  model: KnowledgeModel,
  removed: ReadonlySet<string>,
): DepartureImpact {
  let filesWithExperts = 0;
  let alreadyOrphaned = 0;
  const newlyOrphanedPaths: string[] = [];

  for (const file of model.files) {
    if (file.experts.length === 0) continue;
    filesWithExperts++;
    const activeExperts = file.experts.filter((expert) => expert.active);
    if (activeExperts.length === 0) {
      alreadyOrphaned++;
      continue;
    }
    if (!activeExperts.some((expert) => !removed.has(expert.name))) {
      newlyOrphanedPaths.push(file.path);
    }
  }

  const newlyOrphaned = newlyOrphanedPaths.length;
  return {
    filesWithExperts,
    alreadyOrphaned,
    newlyOrphaned,
    orphanedAfter: alreadyOrphaned + newlyOrphaned,
    newlyOrphanedPaths,
  };
}

/**
 * The contributor leaderboard: each author's commits, knowledge, files owned
 * (as primary expert) and bus risk (files orphaned if they alone left).
 * Highest bus risk first, so the people the project can least afford to lose
 * are at the top. Bots are already excluded by the knowledge model.
 */
export function busFactorBoard(model: KnowledgeModel): Contributor[] {
  const ownedByAuthor = new Map<string, number>();
  for (const file of model.files) {
    const owner = file.primaryExpert?.name;
    if (owner) ownedByAuthor.set(owner, (ownedByAuthor.get(owner) ?? 0) + 1);
  }

  const board = model.authors.map((author) => ({
    name: author.name,
    commits: author.commits,
    knowledge: author.knowledge,
    active: author.active,
    lastActiveAt: author.lastActiveAt,
    filesOwned: ownedByAuthor.get(author.name) ?? 0,
    busRisk: simulateDeparture(model, new Set([author.name])).newlyOrphaned,
  }));

  board.sort(
    (a, b) =>
      b.busRisk - a.busRisk ||
      b.filesOwned - a.filesOwned ||
      b.knowledge - a.knowledge ||
      a.name.localeCompare(b.name),
  );
  return board;
}
