import { CommitInfo } from '../../core/models';
import { BlameOwner, BlameState } from '../../core/store/repo-store';
import { buildAnnotationCells } from './blame-annotation';

const OLDEST = 'text-zinc-600';
const NEWEST = 'text-emerald-300/90';

function commit(sha: string, authoredAt: string, authorName = 'Ada'): CommitInfo {
  return {
    sha,
    message: `commit ${sha}`,
    summary: `commit ${sha}`,
    authorName,
    authorEmail: null,
    authoredAt,
    htmlUrl: `https://example.com/${sha}`,
    parentShas: [],
  };
}

function owner(sha: string, authoredAt: string, line = 1): { commit: CommitInfo; line: number } {
  return { commit: commit(sha, authoredAt), line };
}

function ready(lines: readonly BlameOwner[]): BlameState {
  return { status: 'ready', lines, truncated: false, processed: lines.length };
}

describe('buildAnnotationCells', () => {
  it('labels each line with date and author and keeps the commit position', () => {
    const cells = buildAnnotationCells(ready([owner('abc', '2020-01-01T00:00:00Z', 7)]), 1);
    expect(cells[0].sha).toBe('abc');
    expect(cells[0].lineAtCommit).toBe(7);
    expect(cells[0].label).toBe('01.01.2020 Ada');
    expect(cells[0].pending).toBe(false);
  });

  it('colours lines from oldest to newest by relative commit age', () => {
    const lines = [
      owner('c1', '2020-01-01T00:00:00Z'),
      owner('c2', '2021-01-01T00:00:00Z'),
      owner('c3', '2022-01-01T00:00:00Z'),
      owner('c4', '2023-01-01T00:00:00Z'),
      owner('c5', '2024-01-01T00:00:00Z'),
    ];
    const cells = buildAnnotationCells(ready(lines), lines.length);
    expect(cells[0].labelClass).toBe(OLDEST);
    expect(cells[4].labelClass).toBe(NEWEST);
    // Lines in between sit on distinct, ordered ranks (not clamped to an end).
    expect(cells[1].labelClass).not.toBe(OLDEST);
    expect(cells[1].labelClass).not.toBe(NEWEST);
  });

  it('uses the newest colour when every line shares one commit time', () => {
    const same = '2020-01-01T00:00:00Z';
    const cells = buildAnnotationCells(ready([owner('c1', same), owner('c1', same)]), 2);
    expect(cells[0].labelClass).toBe(NEWEST);
  });

  it('dims continuation lines of a same-commit block', () => {
    const first = owner('c1', '2020-01-01T00:00:00Z');
    const cells = buildAnnotationCells(ready([first, { commit: first.commit, line: 2 }]), 2);
    expect(cells[0].labelClass).not.toContain('opacity-60'); // block start
    expect(cells[1].labelClass).toContain('opacity-60'); // continuation: same colour, dimmed
    expect(cells[1].labelClass.startsWith(cells[0].labelClass)).toBe(true);
  });

  it('marks lines older than the loaded history', () => {
    const cells = buildAnnotationCells(ready(['older', 'older']), 2);
    expect(cells[0].sha).toBeNull();
    expect(cells[0].label).toBe('· · ·');
    expect(cells[1].labelClass).toContain('opacity-60');
  });

  it('renders unattributed lines as pending while computing, blank when done', () => {
    const computing: BlameState = {
      status: 'computing',
      lines: [],
      truncated: false,
      processed: 0,
    };
    expect(buildAnnotationCells(computing, 1)[0].pending).toBe(true);

    const done = buildAnnotationCells(ready([]), 1)[0];
    expect(done.pending).toBe(false);
    expect(done.label).toBe('');
  });
});
