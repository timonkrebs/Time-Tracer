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
    { resolve: (result: AggregateResult) => void; input: AggregateInput }
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
      // A worker that threw asks us to aggregate this request on-thread rather
      // than leaving its promise unresolved.
      entry.resolve(data.failed ? aggregateInsights(entry.input) : data.result!);
    };
    // If the worker ever fails, fall back to on-thread aggregation for the
    // in-flight requests and every later one.
    worker.onerror = () => {
      this.worker = null;
      for (const { resolve, input } of this.pending.values()) resolve(aggregateInsights(input));
      this.pending.clear();
    };
  }

  /** Aggregates `input`, off the main thread when possible. */
  run(input: AggregateInput): Promise<AggregateResult> {
    const worker = this.worker;
    if (!worker) return Promise.resolve(aggregateInsights(input));
    const id = ++this.seq;
    return new Promise<AggregateResult>((resolve) => {
      this.pending.set(id, { resolve, input });
      worker.postMessage({ id, input });
    });
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
