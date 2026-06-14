import { TraceForExport, traceToMarkdown } from './trace-export';

function commit(sha: string, summary: string, authorName: string, authoredAt: string) {
  return { sha, summary, authorName, authoredAt, htmlUrl: `https://example.com/${sha}` };
}

describe('traceToMarkdown', () => {
  it('renders a header, count and one bullet per commit', () => {
    const trace: TraceForExport = {
      path: 'src/app.ts',
      range: { start: 10, end: 12 },
      truncated: false,
      commits: [
        commit('aaaaaaa1', 'feat: add it', 'Ada', '2024-01-02T00:00:00Z'),
        commit('bbbbbbb2', 'fix: tweak it', 'Bob', '2023-06-01T00:00:00Z'),
      ],
    };

    expect(traceToMarkdown(trace)).toBe(
      [
        '### Trace of `src/app.ts` lines 10–12',
        '',
        '2 commits changed these lines:',
        '- [`aaaaaaa`](https://example.com/aaaaaaa1) feat: add it — Ada, 02.01.2024',
        '- [`bbbbbbb`](https://example.com/bbbbbbb2) fix: tweak it — Bob, 01.06.2023',
      ].join('\n'),
    );
  });

  it('uses the singular form and a single-line range', () => {
    const md = traceToMarkdown({
      path: 'a.ts',
      range: { start: 5, end: 5 },
      truncated: false,
      commits: [commit('c1c1c1c1', 'init', 'Ada', '2024-01-01T00:00:00Z')],
    });
    expect(md).toContain('### Trace of `a.ts` line 5');
    expect(md).toContain('1 commit changed these lines:');
  });

  it('notes when the trace is truncated', () => {
    const md = traceToMarkdown({
      path: 'a.ts',
      range: { start: 1, end: 2 },
      truncated: true,
      commits: [commit('c1c1c1c1', 'init', 'Ada', '2024-01-01T00:00:00Z')],
    });
    expect(md).toContain('(within the loaded history)');
  });

  it('handles an empty trace', () => {
    const md = traceToMarkdown({
      path: 'a.ts',
      range: { start: 1, end: 1 },
      truncated: false,
      commits: [],
    });
    expect(md).toContain('_No commits changed these lines in the loaded history._');
  });
});
