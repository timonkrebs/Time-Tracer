/**
 * The repo-wide Insights aggregation, factored out so it can run identically on
 * the main thread or inside the analysis Web Worker (see `analysis.worker.ts`
 * and `core/store/analysis-runner.ts`). Pure — given the same commit window it
 * always produces the same result, and every value it returns survives a
 * structured-clone `postMessage` (plain objects, arrays and `Map`s).
 */

import { CoChangeResult, computeCoChange } from './co-change';
import { Forecast, computeForecast } from './forecast';
import { Hotspot, computeHotspots } from './hotspots';
import { KnowledgeModel, computeKnowledgeRisk } from './knowledge';
import { EMPTY_TEAM_GRAPH, TeamGraph, computeTeamGraph } from './team-graph';

/** A walked commit, reduced to the fields every analysis needs. */
export interface AggregateCommit {
  readonly sha: string;
  readonly authoredAt: string;
  readonly authorName: string;
  readonly authorEmail: string | null;
  readonly files: readonly string[];
  /** Lines removed across the commit's files, when the provider reports them. */
  readonly deletions?: number;
}

export interface AggregateInput {
  /** Commits walked so far, with generated/vendored files already dropped. */
  readonly commits: readonly AggregateCommit[];
  /** Current-tree file sizes (path → bytes). */
  readonly sizes: ReadonlyMap<string, number>;
  /** A single file the analysis is focused on; repo-wide metrics are skipped. */
  readonly focus?: string;
  readonly minSupport?: number;
  /** Whether older history may be unread (marks the knowledge model partial). */
  readonly partial: boolean;
}

export interface AggregateResult {
  readonly result: CoChangeResult;
  readonly hotspots: readonly Hotspot[];
  readonly teamGraph: TeamGraph;
  readonly knowledge: KnowledgeModel;
  readonly forecast: Forecast;
}

const EMPTY_SIZES: ReadonlyMap<string, number> = new Map();
const EMPTY_FORECAST: Forecast = { files: [], splitAt: 0, from: 0, to: 0 };

/** Runs every repo-wide Insights analysis over one commit window. */
export function aggregateInsights(input: AggregateInput): AggregateResult {
  const { commits, sizes, focus } = input;
  // Knowledge-loss risk only makes sense for files that still exist, so drop any
  // touched in history but since deleted from the current tree (absent from `sizes`).
  const knowledgeModel = focus
    ? computeKnowledgeRisk([], EMPTY_SIZES)
    : computeKnowledgeRisk(commits, sizes, { partial: input.partial });
  const knowledge: KnowledgeModel = {
    ...knowledgeModel,
    files: knowledgeModel.files.filter((file) => sizes.has(file.path)),
  };
  return {
    result: computeCoChange(commits, { minSupport: input.minSupport }),
    // Hotspots, the team graph, knowledge and the forecast are repo-wide; a
    // single file's focused walk doesn't have them.
    hotspots: focus ? [] : computeHotspots(commits, sizes),
    teamGraph: focus ? EMPTY_TEAM_GRAPH : computeTeamGraph(commits),
    knowledge,
    forecast: focus ? EMPTY_FORECAST : computeForecast(commits),
  };
}
