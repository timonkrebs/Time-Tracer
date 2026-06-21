import { Injectable, computed, inject, signal } from '@angular/core';

import { ProviderRegistry, RepoWebLinks } from '../git/git-provider';
import { normalizeInstanceHost } from '../git/host-url';
import { AnalysisRunner } from './analysis-runner';
import {
  CommitFileChange,
  CommitInfo,
  FileState,
  RepoFile,
  RepoLoadPhase,
  RepoMetadata,
  RepoProviderError,
  RepoSlug,
  TreeEntry,
  toRepoProviderError,
} from '../models';
import { CoChangeResult, CommitFiles, RelatedFile, relatedFiles } from '../util/co-change';
import { FileDiff, computeFileDiff, diffLines, lineSimilarity, splitLines } from '../util/diff';
import { FileMetric, Hotspot, computeFileMetric } from '../util/hotspots';
import { isGeneratedFile } from '../util/ignore';
import { KnowledgeModel } from '../util/knowledge';
import { TeamGraph } from '../util/team-graph';
import { AggregateInput, AggregateResult, aggregateInsights } from '../util/analysis';
import { Forecast } from '../util/forecast';
import {
  LineRange,
  changeRegions,
  followRange,
  movedLinePairs,
  regionTouchesRange,
} from '../util/line-range';
import { findBlockOrigin, fuzzyLineSimilarity } from '../util/similarity';
import {
  FileRisk,
  OwnershipSummary,
  computeOwnershipRisk,
  selectOwnershipFiles,
  summarizeOwnership,
} from '../util/ownership';
import { applyPatch, parsePatch, patchStatsMatch } from '../util/patch';
import {
  CohortBucket,
  LineLifetime,
  SurvivalReport,
  cohortStackFor,
  summarizeSurvival,
} from '../util/survival';
import { ancestorsOf, buildTree } from '../util/tree';
import { RecentRepos } from './recent-repos';