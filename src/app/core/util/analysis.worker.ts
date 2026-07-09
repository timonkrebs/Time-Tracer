/// <reference lib="webworker" />

/**
 * Analysis Web Worker: runs the (pure, CPU-bound) Insights aggregation off the
 * main thread so walking a long history stays responsive. Messages carry a
 * request id and an {@link AggregateInput}; the reply carries the id and the
 * {@link AggregateResult}. See `core/store/analysis-runner.ts`.
 */

import { AggregateInput, AggregateResult, aggregateInsights } from './analysis';

addEventListener('message', ({ data }: MessageEvent<{ id: number; input: AggregateInput }>) => {
  try {
    const result: AggregateResult = aggregateInsights(data.input);
    postMessage({ id: data.id, result });
  } catch {
    // Don't leave the request's promise pending forever — ask the main thread to
    // aggregate this one itself (analysis-runner falls back to on-thread).
    postMessage({ id: data.id, failed: true });
  }
});
