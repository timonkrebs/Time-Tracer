import { Injectable } from '@angular/core';

import { AggregateInput, AggregateResult, aggregateInsights } from '../util/analysis';

/**
 * Runs the Insights aggregation off the main thread in a Web Worker so long
 * history walks stay responsive. Falls back to running it synchronously when
 * Workers are unavailable (unit tests in jsdom, or a browser that fails to
 * construct the worker) — so behaviour is identical, just on-thread.
 */
@Injectable({ providedIn: 'root' })
export class AnalysisRunner {
  private worker: Worker | null = createWorker();
  private seq = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (result: AggregateResult) => void;
      reject: (error: unknown) => void;
      input: AggregateInput;
    }
  >();

  /** True when aggregation actually runs off the main thread. */
  readonly offThread = this.worker !== null;

  constructor() {
    const worker = this.worker;
    if (!worker) return;
    worker.onmessage = ({
      data,
    }: MessageEvent<{ id: number; result?: AggregateResult; failed?: boolean }>) => {
      const entry = this.pending.get(data.id);
      if (!entry) return;
      this.pending.delete(data.id);
      // A worker that threw (or a message with no result) asks us to aggregate
      // this request on-thread. If that deterministic failure recurs here, reject
      // so the caller surfaces an error instead of the request hanging forever.
      settle(entry, () =>
        data.failed || data.result === undefined ? aggregateInsights(entry.input) : data.result,
      );
    };
    // If the worker ever fails, fall back to on-thread aggregation for the
    // in-flight requests and every later one.
    worker.onerror = () => {
      this.worker = null;
      const entries = [...this.pending.values()];
      this.pending.clear();
      for (const entry of entries) settle(entry, () => aggregateInsights(entry.input));
    };
  }

  /** Aggregates `input`, off the main thread when possible. */
  run(input: AggregateInput): Promise<AggregateResult> {
    const worker = this.worker;
    if (!worker) {
      try {
        return Promise.resolve(aggregateInsights(input));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const id = ++this.seq;
    return new Promise<AggregateResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, input });
      worker.postMessage({ id, input });
    });
  }
}

/** Resolves a pending request with `compute()`'s result, or rejects it if that throws. */
function settle(
  entry: { resolve: (result: AggregateResult) => void; reject: (error: unknown) => void },
  compute: () => AggregateResult,
): void {
  try {
    entry.resolve(compute());
  } catch (error) {
    entry.reject(error);
  }
}

function createWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('../util/analysis.worker', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}
