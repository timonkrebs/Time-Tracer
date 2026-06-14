import { shortDate, shortSha } from './relative-time';

/**
 * Minimal shape of a line trace this exporter needs — structurally satisfied
 * by the store's `LineTraceState`, so it stays decoupled from it.
 */
export interface TraceForExport {
  readonly path: string;
  readonly range: { readonly start: number; readonly end: number };
  /** True when the walk paused at the end of the loaded history pages. */
  readonly truncated: boolean;
  readonly commits: readonly {
    readonly sha: string;
    readonly summary: string;
    readonly authorName: string;
    readonly authoredAt: string;
    readonly htmlUrl: string;
  }[];
}

/** Renders a line trace as a shareable Markdown summary. */
export function traceToMarkdown(trace: TraceForExport): string {
  const { start, end } = trace.range;
  const range = start === end ? `line ${start}` : `lines ${start}–${end}`;
  const header = `### Trace of \`${trace.path}\` ${range}`;

  if (trace.commits.length === 0) {
    return `${header}\n\n_No commits changed these lines in the loaded history._`;
  }

  const count = trace.commits.length;
  const intro = `${count} commit${count === 1 ? '' : 's'} changed these lines${
    trace.truncated ? ' (within the loaded history)' : ''
  }:`;
  const rows = trace.commits.map((c) => {
    const link = c.htmlUrl ? `[\`${shortSha(c.sha)}\`](${c.htmlUrl})` : `\`${shortSha(c.sha)}\``;
    return `- ${link} ${c.summary} — ${c.authorName}, ${shortDate(c.authoredAt)}`;
  });

  return `${header}\n\n${intro}\n${rows.join('\n')}`;
}
