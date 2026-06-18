import { TestBed } from '@angular/core/testing';

import { GIT_PROVIDERS, GitProvider, RepoWebLinks } from '../git/git-provider';
import {
  CommitFileChange,
  CommitInfo,
  ParsedRepoUrl,
  RepoFile,
  RepoMetadata,
  RepoProviderError,
  RepoSlug,
  RepoTree,
  TreeEntry,
} from '../models';
import { RepoStore } from './repo-store';

const slug: RepoSlug = { provider: 'github', owner: 'acme', repo: 'rocket' };

const metadata: RepoMetadata = {
  owner: 'acme',
  name: 'rocket',
  fullName: 'acme/rocket',
  description: 'a rocket',
  defaultBranch: 'main',
  htmlUrl: 'https://github.com/acme/rocket',
  starCount: 1,
  isFork: false,
};

const entries: TreeEntry[] = [
  { path: 'src', name: 'src', kind: 'dir', sha: 't1' },
  { path: 'src/deep', name: 'deep', kind: 'dir', sha: 't2' },
  { path: 'src/deep/main.ts', name: 'main.ts', kind: 'file', sha: 'b1', size: 10 },
  { path: 'README.md', name: 'README.md', kind: 'file', sha: 'b2', size: 5 },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeProvider implements GitProvider {
  readonly id = 'github';
  readonly label = 'Fake';

  metadataCalls = 0;
  treeCalls = 0;
  fileCalls: string[] = [];
  fileAtRefCalls: { path: string; ref: string }[] = [];
  listCommitsCalls: { ref?: string; path?: string; perPage?: number; page?: number }[] = [];
  treeRefs: string[] = [];

  metadataResult: () => Promise<RepoMetadata> = () => Promise.resolve(metadata);
  treeResult: (ref: string) => Promise<RepoTree> = () =>
    Promise.resolve({ entries, truncated: false });
  fileResult: (entry: TreeEntry) => Promise<RepoFile> = (entry) =>
    Promise.resolve({
      kind: 'text',
      path: entry.path,
      sha: entry.sha,
      size: entry.size ?? 0,
      text: 'content of ' + entry.path,
    });
  fileAtRefResult: (path: string, ref: string) => Promise<RepoFile> = (path, ref) =>
    Promise.resolve({
      kind: 'text',
      path,
      sha: `blob-at-${ref}`,
      size: 0,
      text: `content of ${path} at ${ref}`,
    });
  listCommitsResult: () => Promise<CommitInfo[]> = () => Promise.resolve([]);
  commitResult: (sha: string) => Promise<CommitInfo> = (sha) => Promise.resolve(commit(sha));

  canHandle(): boolean {
    return true;
  }
  parseUrl(): ParsedRepoUrl | null {
    return null;
  }
  getMetadata(): Promise<RepoMetadata> {
    this.metadataCalls++;
    return this.metadataResult();
  }
  getTree(_slug: RepoSlug, ref: string): Promise<RepoTree> {
    this.treeCalls++;
    this.treeRefs.push(ref);
    return this.treeResult(ref);
  }
  getFile(_slug: RepoSlug, entry: TreeEntry): Promise<RepoFile> {
    this.fileCalls.push(entry.path);
    return this.fileResult(entry);
  }
  getFileAtRef(_slug: RepoSlug, path: string, ref: string): Promise<RepoFile> {
    this.fileAtRefCalls.push({ path, ref });
    return this.fileAtRefResult(path, ref);
  }
  listCommits(
    _slug: RepoSlug,
    options: { ref?: string; path?: string; perPage?: number; page?: number } = {},
  ): Promise<CommitInfo[]> {
    this.listCommitsCalls.push(options);
    return this.listCommitsResult();
  }
  getCommit(_slug: RepoSlug, sha: string): Promise<CommitInfo> {
    this.getCommitCalls.push(sha);
    return this.commitResult(sha);
  }
  getCommitCalls: string[] = [];
  commitFilesResult: (sha: string) => Promise<CommitFileChange[]> = () => Promise.resolve([]);
  getCommitFiles(_slug: RepoSlug, sha: string): Promise<CommitFileChange[]> {
    return this.commitFilesResult(sha);
  }
  primeHistoriesCalls: string[] = [];
  primeHistories(_slug: RepoSlug, ref: string): Promise<void> {
    this.primeHistoriesCalls.push(ref);
    return Promise.resolve();
  }
  webLinks(): RepoWebLinks {
    return { repoUrl: 'https://github.com/acme/rocket' };
  }
}

function commit(sha: string, parents: string[] = []): CommitInfo {
  return {
    sha,
    message: `commit ${sha}`,
    summary: `commit ${sha}`,
    authorName: 'Ada',
    authorEmail: null,
    authoredAt: '2026-01-01T00:00:00Z',
    htmlUrl: `https://github.com/acme/rocket/commit/${sha}`,
    parentShas: parents,
  };
}

describe('RepoStore', () => {
  let store: RepoStore;
  let provider: FakeProvider;

  beforeEach(() => {
    localStorage.clear();
    provider = new FakeProvider();
    TestBed.configureTestingModule({
      providers: [{ provide: GIT_PROVIDERS, useValue: [provider] }],
    });
    store = TestBed.inject(RepoStore);
  });

  it('loads metadata and tree, then becomes ready', async () => {
    await store.loadRepo(slug);

    expect(store.phase()).toBe('ready');
    expect(store.metadata()).toEqual(metadata);
    expect(store.ref()).toBe('main');
    expect(store.fileCount()).toBe(2);
    expect(store.dirCount()).toBe(2);
    expect(store.tree().map((n) => n.path)).toEqual(['src', 'README.md']);
    expect(provider.treeRefs).toEqual(['main']);
  });

  it('uses the requested ref instead of the default branch', async () => {
    await store.loadRepo(slug, 'v2');

    expect(store.ref()).toBe('v2');
    expect(provider.treeRefs).toEqual(['v2']);
  });

  it('reports local data availability from the provider capability', async () => {
    // No repository loaded yet: there is nothing to read locally.
    expect(store.hasLocalData()).toBe(false);

    await store.loadRepo(slug);

    // The fake provider implements primeHistories — the local-database marker
    // that makes bulk passes (the folder ownership scan) free of network calls.
    expect(store.hasLocalData()).toBe(true);
  });

  it('does not reload an already-loaded target', async () => {
    await store.loadRepo(slug);
    await store.loadRepo({ ...slug, owner: 'ACME' });

    expect(provider.metadataCalls).toBe(1);
  });

  it('surfaces provider errors with their kind', async () => {
    provider.metadataResult = () => Promise.reject(new RepoProviderError('nope', 'not-found'));

    await store.loadRepo(slug);

    expect(store.phase()).toBe('error');
    expect(store.error()?.kind).toBe('not-found');
  });

  it('retries after an error', async () => {
    provider.metadataResult = () => Promise.reject(new RepoProviderError('nope', 'network'));
    await store.loadRepo(slug);
    expect(store.phase()).toBe('error');

    provider.metadataResult = () => Promise.resolve(metadata);
    store.retry();
    await vi.waitFor(() => expect(store.phase()).toBe('ready'));
    expect(provider.metadataCalls).toBe(2);
  });

  it('ignores results of a superseded load (race safety)', async () => {
    const slow = deferred<RepoMetadata>();
    provider.metadataResult = () => slow.promise;
    const first = store.loadRepo(slug);

    provider.metadataResult = () => Promise.resolve({ ...metadata, fullName: 'other/repo' });
    const second = store.loadRepo({ provider: 'github', owner: 'other', repo: 'repo' });

    slow.resolve({ ...metadata, fullName: 'acme/rocket' });
    await Promise.all([first, second]);

    expect(store.metadata()?.fullName).toBe('other/repo');
    expect(store.phase()).toBe('ready');
  });

  it('opens a file and caches its content per path', async () => {
    await store.loadRepo(slug);

    await store.openFile('README.md');
    await store.openFile('README.md');

    expect(provider.fileCalls).toEqual(['README.md']);
    const state = store.selectedFile();
    expect(state?.status).toBe('ready');
    expect(state?.status === 'ready' && state.file.kind === 'text' && state.file.text).toBe(
      'content of README.md',
    );
  });

  it('expands all ancestors when opening a nested file', async () => {
    await store.loadRepo(slug);

    await store.openFile('src/deep/main.ts');

    expect(store.expandedDirs().has('src')).toBe(true);
    expect(store.expandedDirs().has('src/deep')).toBe(true);
    expect(store.selectedPath()).toBe('src/deep/main.ts');
  });

  it('marks unknown paths as errors without calling the provider', async () => {
    await store.loadRepo(slug);

    await store.openFile('does/not/exist.ts');

    expect(provider.fileCalls).toEqual([]);
    expect(store.selectedFile()?.status).toBe('error');
  });

  it('records successful loads in recent repos', async () => {
    await store.loadRepo(slug);

    const stored = JSON.parse(localStorage.getItem('time-tracer.recent-repos') ?? '[]') as {
      owner: string;
      repo: string;
    }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ owner: 'acme', repo: 'rocket' });
  });

  it('toggles directories', async () => {
    await store.loadRepo(slug);

    store.toggleDir('src');
    expect(store.expandedDirs().has('src')).toBe(true);
    store.toggleDir('src');
    expect(store.expandedDirs().has('src')).toBe(false);
  });

  describe('time travel (openFile at a commit)', () => {
    beforeEach(async () => {
      await store.loadRepo(slug);
    });

    it('fetches historical content via getFileAtRef and caches it separately', async () => {
      await store.openFile('README.md');
      await store.openFile('README.md', 'oldsha');

      expect(provider.fileCalls).toEqual(['README.md']);
      expect(provider.fileAtRefCalls).toEqual([{ path: 'README.md', ref: 'oldsha' }]);
      expect(store.viewAt()).toBe('oldsha');
      const state = store.selectedFile();
      expect(state?.status === 'ready' && state.file.kind === 'text' && state.file.text).toBe(
        'content of README.md at oldsha',
      );
    });

    it('returns to the cached tip version without refetching', async () => {
      await store.openFile('README.md');
      await store.openFile('README.md', 'oldsha');
      await store.openFile('README.md', null);

      expect(provider.fileCalls).toEqual(['README.md']);
      expect(store.viewAt()).toBeNull();
      const state = store.selectedFile();
      expect(state?.status === 'ready' && state.file.kind === 'text' && state.file.text).toBe(
        'content of README.md',
      );
    });

    it('surfaces a missing path at the commit as a file error', async () => {
      provider.fileAtRefResult = () => Promise.reject(new RepoProviderError('gone', 'not-found'));

      await store.openFile('README.md', 'oldsha');

      expect(store.selectedFile()).toMatchObject({ status: 'error', message: 'gone' });
    });

    it('clearSelection resets the time-travel state', async () => {
      await store.openFile('README.md', 'oldsha');
      store.clearSelection();

      expect(store.selectedPath()).toBeNull();
      expect(store.viewAt()).toBeNull();
    });
  });

  describe('file history', () => {
    beforeEach(async () => {
      await store.loadRepo(slug);
    });

    it('loads the first page for the snapshot ref', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('c1'), commit('c2')]);

      await store.loadHistory('README.md');

      expect(provider.listCommitsCalls).toEqual([{ ref: 'main', path: 'README.md', perPage: 30 }]);
      expect(store.historyStatus()).toBe('ready');
      expect(store.history().map((c) => c.sha)).toEqual(['c1', 'c2']);
      expect(store.historyHasMore()).toBe(false);
    });

    it('does not reload history for the same path', async () => {
      await store.loadHistory('README.md');
      await store.loadHistory('README.md');

      expect(provider.listCommitsCalls).toHaveLength(1);
    });

    it('paginates and appends older commits', async () => {
      const fullPage = Array.from({ length: 30 }, (_, i) => commit(`a${i}`));
      provider.listCommitsResult = () => Promise.resolve(fullPage);
      await store.loadHistory('README.md');
      expect(store.historyHasMore()).toBe(true);

      provider.listCommitsResult = () => Promise.resolve([commit('tail')]);
      await store.loadMoreHistory();

      expect(provider.listCommitsCalls[1]).toMatchObject({ page: 2 });
      expect(store.history()).toHaveLength(31);
      expect(store.history().at(-1)?.sha).toBe('tail');
      expect(store.historyHasMore()).toBe(false);
    });

    it('loads every remaining page at once with loadAllHistory', async () => {
      const page1 = Array.from({ length: 30 }, (_, i) => commit(`a${i}`));
      const page2 = Array.from({ length: 30 }, (_, i) => commit(`b${i}`));
      let calls = 0;
      provider.listCommitsResult = () => {
        calls++;
        // Pages 1–2 are full (more remains); page 3 ends the history.
        return Promise.resolve(calls === 1 ? page1 : calls === 2 ? page2 : [commit('tail')]);
      };
      await store.loadHistory('README.md');
      expect(store.historyHasMore()).toBe(true);

      await store.loadAllHistory();

      // The first page came from loadHistory (no page param); load-all walked on.
      expect(provider.listCommitsCalls.map((c) => c.page)).toEqual([undefined, 2, 3]);
      expect(store.history()).toHaveLength(61);
      expect(store.history().at(-1)?.sha).toBe('tail');
      expect(store.historyHasMore()).toBe(false);
      expect(store.historyStatus()).toBe('ready');
    });

    it('exposes errors and recovers via retryHistory', async () => {
      provider.listCommitsResult = () => Promise.reject(new RepoProviderError('boom', 'network'));
      await store.loadHistory('README.md');
      expect(store.historyStatus()).toBe('error');
      expect(store.historyError()).toBe('boom');

      provider.listCommitsResult = () => Promise.resolve([commit('c1')]);
      store.retryHistory();
      await vi.waitFor(() => expect(store.historyStatus()).toBe('ready'));
      expect(store.history()).toHaveLength(1);
    });

    it('resolves viewAtCommit from the loaded history', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('c1'), commit('c2')]);
      await store.loadHistory('README.md');

      await store.openFile('README.md', 'c2');
      expect(store.viewAtCommit()?.sha).toBe('c2');

      await store.openFile('README.md', 'unknown-sha');
      expect(store.viewAtCommit()).toBeNull();
    });

    it('is reset by a new repository load', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('c1')]);
      await store.loadHistory('README.md');
      await store.openFile('README.md', 'c1');

      await store.loadRepo({ provider: 'github', owner: 'other', repo: 'repo' });

      expect(store.historyStatus()).toBe('idle');
      expect(store.history()).toEqual([]);
      expect(store.viewAt()).toBeNull();
    });
  });

  describe('diffs (loadDiff)', () => {
    beforeEach(async () => {
      await store.loadRepo(slug);
    });

    function textFile(path: string, ref: string, text: string): Promise<RepoFile> {
      return Promise.resolve({ kind: 'text', path, sha: `blob-${ref}`, size: text.length, text });
    }

    it('diffs the commit version against its first parent', async () => {
      provider.commitResult = (sha) => Promise.resolve(commit(sha, ['parent']));
      provider.fileAtRefResult = (path, ref) =>
        textFile(path, ref, ref === 'child' ? 'a\nNEW\nc\n' : 'a\nb\nc\n');

      await store.openFile('README.md', 'child');
      await store.loadDiff('README.md', 'child');

      const state = store.selectedDiff();
      expect(state?.status).toBe('ready');
      if (state?.status !== 'ready') return;
      expect(state.baseSha).toBe('parent');
      expect(state.basePath).toBe('README.md');
      expect(state.headPath).toBe('README.md');
      expect(state.diff.added).toBe(1);
      expect(state.diff.removed).toBe(1);
      expect(provider.fileAtRefCalls).toEqual([
        { path: 'README.md', ref: 'child' },
        { path: 'README.md', ref: 'parent' },
      ]);
    });

    it('treats a missing base as an added file (diff vs empty)', async () => {
      provider.commitResult = (sha) => Promise.resolve(commit(sha, ['parent']));
      provider.fileAtRefResult = (path, ref) =>
        ref === 'parent'
          ? Promise.reject(new RepoProviderError('absent', 'not-found'))
          : textFile(path, ref, 'a\nb\n');

      await store.openFile('README.md', 'child');
      await store.loadDiff('README.md', 'child');

      const state = store.selectedDiff();
      expect(state?.status).toBe('ready');
      if (state?.status !== 'ready') return;
      expect(state.basePath).toBeNull();
      expect(state.headPath).toBe('README.md');
      expect(state.diff.added).toBe(2);
      expect(state.diff.removed).toBe(0);
    });

    it('shows a file introduced by a rename as added, not diffed against its source', async () => {
      // The oldest commit of a path's recorded history is where it was born:
      // present it as an addition rather than diffing it against the file it
      // was renamed from. That predecessor is reached via the history panel's
      // "Continue past the rename?" step instead (issue #8).
      provider.commitResult = (sha) => Promise.resolve(commit(sha, ['parent']));
      provider.commitFilesResult = () =>
        Promise.resolve([{ path: 'README.md', status: 'renamed', previousPath: 'docs/README.md' }]);
      provider.fileAtRefResult = (path, ref) => {
        if (ref === 'parent' && path === 'README.md') {
          return Promise.reject(new RepoProviderError('absent', 'not-found'));
        }
        if (ref === 'parent' && path === 'docs/README.md') {
          return textFile(path, ref, 'a\nold\nc\n');
        }
        return textFile(path, ref, 'a\nnew\nc\n');
      };

      await store.openFile('README.md', 'child');
      await store.loadDiff('README.md', 'child');

      const state = store.selectedDiff();
      expect(state?.status).toBe('ready');
      if (state?.status !== 'ready') return;
      expect(state.baseSha).toBe('parent');
      expect(state.basePath).toBeNull();
      expect(state.headPath).toBe('README.md');
      expect(state.diff.added).toBe(3);
      expect(state.diff.removed).toBe(0);
      // The file it was renamed from is never fetched as a diff base.
      expect(provider.fileAtRefCalls).not.toContainEqual({ path: 'docs/README.md', ref: 'parent' });
    });

    it('diffs against a chosen predecessor when a base path is given', async () => {
      // "Diff" on a rename candidate: compare the file at its creation against
      // the selected predecessor at the parent (issue #8 follow-up).
      provider.commitResult = (sha) => Promise.resolve(commit(sha, ['parent']));
      provider.fileAtRefResult = (path, ref) => {
        if (ref === 'parent' && path === 'README.md') {
          return Promise.reject(new RepoProviderError('absent', 'not-found'));
        }
        if (ref === 'parent' && path === 'docs/OLD.md') {
          return textFile(path, ref, 'a\nold\nc\n');
        }
        return textFile(path, ref, 'a\nnew\nc\n');
      };

      await store.openFile('README.md', 'child');
      store.setCompareBase('docs/OLD.md');
      await store.loadDiff('README.md', 'child', 'docs/OLD.md');

      const state = store.selectedDiff();
      expect(state?.status).toBe('ready');
      if (state?.status !== 'ready') return;
      expect(state.baseSha).toBe('parent');
      expect(state.basePath).toBe('docs/OLD.md');
      expect(state.headPath).toBe('README.md');
      expect(state.diff.added).toBe(1);
      expect(state.diff.removed).toBe(1);
      expect(provider.fileAtRefCalls).toContainEqual({ path: 'docs/OLD.md', ref: 'parent' });
    });

    it('caches the commit diff and a predecessor comparison separately', async () => {
      provider.commitResult = (sha) => Promise.resolve(commit(sha, ['parent']));
      provider.fileAtRefResult = (path, ref) => {
        if (ref === 'parent' && path === 'README.md') {
          return Promise.reject(new RepoProviderError('absent', 'not-found'));
        }
        if (ref === 'parent' && path === 'docs/OLD.md') {
          return textFile(path, ref, 'a\nold\nc\n');
        }
        return textFile(path, ref, 'a\nnew\nc\n');
      };

      await store.openFile('README.md', 'child');
      await store.loadDiff('README.md', 'child'); // the commit's own changes (added)
      await store.loadDiff('README.md', 'child', 'docs/OLD.md'); // vs the predecessor

      store.setCompareBase(null);
      expect(store.selectedDiff()).toMatchObject({ status: 'ready', basePath: null });
      store.setCompareBase('docs/OLD.md');
      expect(store.selectedDiff()).toMatchObject({ status: 'ready', basePath: 'docs/OLD.md' });
    });

    it('diffs a path renamed away against the new path at the commit', async () => {
      provider.commitResult = (sha) => Promise.resolve(commit(sha, ['parent']));
      provider.commitFilesResult = () =>
        Promise.resolve([{ path: 'README.md', status: 'renamed', previousPath: 'docs/README.md' }]);
      provider.fileAtRefResult = (path, ref) => {
        if (ref === 'child' && path === 'docs/README.md') {
          return Promise.reject(new RepoProviderError('absent', 'not-found'));
        }
        if (ref === 'child' && path === 'README.md') {
          return textFile(path, ref, 'a\nnew\nc\n');
        }
        return textFile(path, ref, 'a\nold\nc\n');
      };

      await store.openFile('docs/README.md', 'child');
      await store.loadDiff('docs/README.md', 'child');

      const state = store.selectedDiff();
      expect(state?.status).toBe('ready');
      if (state?.status !== 'ready') return;
      expect(state.basePath).toBe('docs/README.md');
      expect(state.headPath).toBe('README.md');
      expect(state.diff.added).toBe(1);
      expect(state.diff.removed).toBe(1);
      expect(provider.fileAtRefCalls).toContainEqual({ path: 'README.md', ref: 'child' });
    });

    it('diffs a root commit against nothing without fetching a base', async () => {
      provider.commitResult = (sha) => Promise.resolve(commit(sha, []));
      provider.fileAtRefResult = (path, ref) => textFile(path, ref, 'only\n');

      await store.openFile('README.md', 'child');
      await store.loadDiff('README.md', 'child');

      const state = store.selectedDiff();
      expect(state?.status).toBe('ready');
      if (state?.status !== 'ready') return;
      expect(state.baseSha).toBeNull();
      expect(state.basePath).toBeNull();
      expect(state.headPath).toBe('README.md');
      expect(state.diff.added).toBe(1);
      expect(provider.fileAtRefCalls.filter((c) => c.ref !== 'child')).toEqual([]);
    });

    it('marks binary content as unavailable', async () => {
      provider.commitResult = (sha) => Promise.resolve(commit(sha, ['parent']));
      provider.fileAtRefResult = (path, ref) =>
        ref === 'child'
          ? Promise.resolve({ kind: 'binary', path, sha: 'b', size: 10 })
          : textFile(path, ref, 'a\n');

      await store.openFile('README.md', 'child');
      await store.loadDiff('README.md', 'child');

      expect(store.selectedDiff()).toMatchObject({ status: 'unavailable' });
    });

    it('refetches cached commits that lack parents (Azure DevOps lists)', async () => {
      // A history entry without parent ids must not be mistaken for a root.
      provider.listCommitsResult = () => Promise.resolve([commit('child', [])]);
      await store.loadHistory('README.md');
      provider.commitResult = (sha) => Promise.resolve(commit(sha, ['parent']));

      await store.openFile('README.md', 'child');
      await store.loadDiff('README.md', 'child');

      expect(provider.getCommitCalls).toEqual(['child']);
      const state = store.selectedDiff();
      expect(state?.status).toBe('ready');
      if (state?.status === 'ready') expect(state.baseSha).toBe('parent');
    });

    it('uses the history-populated commit cache instead of getCommit', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('child', ['parent'])]);
      await store.loadHistory('README.md');

      await store.openFile('README.md', 'child');
      await store.loadDiff('README.md', 'child');

      expect(provider.getCommitCalls).toEqual([]);
      expect(store.selectedDiff()?.status).toBe('ready');
    });

    it('caches the diff per commit and path', async () => {
      provider.commitResult = (sha) => Promise.resolve(commit(sha, ['parent']));

      await store.openFile('README.md', 'child');
      await store.loadDiff('README.md', 'child');
      await store.loadDiff('README.md', 'child');

      expect(provider.getCommitCalls).toEqual(['child']);
      expect(provider.fileAtRefCalls.filter((c) => c.ref === 'parent')).toHaveLength(1);
    });

    it('surfaces commit resolution failures and recovers on retry', async () => {
      provider.commitResult = () => Promise.reject(new RepoProviderError('boom', 'network'));
      await store.openFile('README.md', 'child');
      await store.loadDiff('README.md', 'child');
      expect(store.selectedDiff()).toMatchObject({ status: 'error', message: 'boom' });

      provider.commitResult = (sha) => Promise.resolve(commit(sha, ['parent']));
      await store.loadDiff('README.md', 'child');
      expect(store.selectedDiff()?.status).toBe('ready');
    });
  });

  describe('blame (loadBlame)', () => {
    beforeEach(async () => {
      await store.loadRepo(slug);
    });

    function text(path: string, sha: string, content: string): Promise<RepoFile> {
      return Promise.resolve({ kind: 'text', path, sha, size: content.length, text: content });
    }

    function ownerShas(): (string | null)[] {
      const blame = store.selectedBlame();
      return (blame?.lines ?? []).map((o) =>
        o && o !== 'older' ? o.commit.sha : (o as string | null),
      );
    }

    function ownerLines(): (number | null)[] {
      const blame = store.selectedBlame();
      return (blame?.lines ?? []).map((o) => (o && o !== 'older' ? o.line : null));
    }

    it('attributes every line to the commit that introduced it', async () => {
      provider.listCommitsResult = () =>
        Promise.resolve([commit('c3'), commit('c2'), commit('c1')]);
      provider.fileResult = (entry) => text(entry.path, entry.sha, 'A\nB2\nC3\n');
      provider.fileAtRefResult = (path, ref) =>
        text(path, `blob-${ref}`, ref === 'c2' ? 'A\nB2\n' : 'A\n');

      await store.openFile('README.md');
      await store.loadBlame('README.md');

      const blame = store.selectedBlame();
      expect(blame?.status).toBe('ready');
      expect(blame?.truncated).toBe(false);
      expect(ownerShas()).toEqual(['c1', 'c2', 'c3']);
      // Each line's position as of its introducing commit.
      expect(ownerLines()).toEqual([1, 2, 3]);
      // Only the two older versions needed fetching; the tip was cached.
      expect(provider.fileAtRefCalls).toEqual([
        { path: 'README.md', ref: 'c2' },
        { path: 'README.md', ref: 'c1' },
      ]);
    });

    it('blames a historical version from its anchor in the history', async () => {
      provider.listCommitsResult = () =>
        Promise.resolve([commit('c3'), commit('c2'), commit('c1')]);
      provider.fileAtRefResult = (path, ref) =>
        text(path, `blob-${ref}`, ref === 'c2' ? 'A\nB2\n' : 'A\n');

      await store.openFile('README.md', 'c2');
      await store.loadBlame('README.md', 'c2');

      expect(store.selectedBlame()?.status).toBe('ready');
      expect(ownerShas()).toEqual(['c1', 'c2']);
    });

    it('keeps a moved line attributed to the commit that introduced it', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('c2'), commit('c1')]);
      provider.fileResult = (entry) => text(entry.path, entry.sha, 'A\nC\nB\n');
      provider.fileAtRefResult = (path, ref) =>
        text(path, `blob-${ref}`, ref === 'c2' ? 'A\nC\nB\n' : 'A\nB\nC\n');

      await store.openFile('README.md');
      await store.loadBlame('README.md');

      expect(store.selectedBlame()?.status).toBe('ready');
      expect(ownerShas()).toEqual(['c1', 'c1', 'c1']);
      expect(ownerLines()).toEqual([1, 3, 2]);
    });

    it('marks lines beyond the loaded pages as older and extends later', async () => {
      // A full page of 30 commits ⇒ hasMore. Version at c_i = lines L_i…L_29.
      const pageOne = Array.from({ length: 30 }, (_, i) => commit(`c${i}`));
      const textFor = (i: number): string =>
        Array.from({ length: 30 - i }, (_, k) => `L${i + k}`).join('\n') + '\n';
      provider.listCommitsResult = () => Promise.resolve(pageOne);
      provider.fileResult = (entry) => text(entry.path, entry.sha, textFor(0));
      provider.fileAtRefResult = (path, ref) =>
        text(path, `blob-${ref}`, ref === 'c30' ? textFor(29) : textFor(Number(ref.slice(1))));

      await store.openFile('README.md');
      await store.loadBlame('README.md');

      let blame = store.selectedBlame();
      expect(blame?.status).toBe('ready');
      expect(blame?.truncated).toBe(true);
      expect(ownerShas()[0]).toBe('c0');
      expect(ownerShas()[28]).toBe('c28');
      expect(ownerShas()[29]).toBe('older');

      // The next page completes the history; blame extends incrementally.
      provider.listCommitsResult = () => Promise.resolve([commit('c30')]);
      await store.loadMoreHistory();
      await store.loadBlame('README.md');

      blame = store.selectedBlame();
      expect(blame?.truncated).toBe(false);
      expect(ownerShas()[29]).toBe('c30');
      // Re-running reused every cached version: only c30 was newly fetched.
      expect(provider.fileAtRefCalls).toHaveLength(30);
    });

    it('is unavailable for binary files', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('c1')]);
      provider.fileResult = (entry) =>
        Promise.resolve({ kind: 'binary', path: entry.path, sha: entry.sha, size: 4 });

      await store.openFile('README.md');
      await store.loadBlame('README.md');

      expect(store.selectedBlame()).toMatchObject({ status: 'unavailable' });
    });

    it('is unavailable when the viewed version is not in the history', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('c1')]);

      await store.openFile('README.md', 'ghost');
      await store.loadBlame('README.md', 'ghost');

      expect(store.selectedBlame()).toMatchObject({ status: 'unavailable' });
    });

    it('attributes a deleted-then-re-added file to the re-add, not a not-found error', async () => {
      // README.md was deleted at c2 and re-added at c3, so its history lists all
      // three commits — but the file is absent from c2's tree.
      provider.listCommitsResult = () =>
        Promise.resolve([commit('c3'), commit('c2'), commit('c1')]);
      provider.fileResult = (entry) => text(entry.path, entry.sha, 'A\nB\n');
      provider.fileAtRefResult = (path, ref) => {
        if (ref === 'c2') {
          return Promise.reject(
            new RepoProviderError(
              `"${path}" does not exist at c2 — deleted by this commit.`,
              'not-found',
            ),
          );
        }
        return text(path, `blob-${ref}`, 'A\nB\n');
      };

      await store.openFile('README.md');
      await store.loadBlame('README.md');

      const blame = store.selectedBlame();
      // The gap at c2 is not surfaced as an error: every line is attributed to
      // the re-add (c3), exactly as if c3 had created the file.
      expect(blame?.status).toBe('ready');
      expect(blame?.truncated).toBe(false);
      expect(ownerShas()).toEqual(['c3', 'c3']);
      // The walk stopped at the gap and never fetched the older c1.
      expect(provider.fileAtRefCalls).toEqual([{ path: 'README.md', ref: 'c2' }]);
    });
  });

  describe('line trace (startLineTrace)', () => {
    beforeEach(async () => {
      await store.loadRepo(slug);
    });

    function text(path: string, sha: string, content: string): Promise<RepoFile> {
      return Promise.resolve({ kind: 'text', path, sha, size: content.length, text: content });
    }

    function traceShas(): string[] {
      return (store.lineTrace()?.commits ?? []).map((c) => c.sha);
    }

    function traceHits(): { sha: string; range: { start: number; end: number } }[] {
      return (store.lineTrace()?.hits ?? []).map((hit) => ({
        sha: hit.commit.sha,
        range: hit.range,
      }));
    }

    it('keeps only the commits that changed the traced lines', async () => {
      provider.listCommitsResult = () =>
        Promise.resolve([commit('c3'), commit('c2'), commit('c1')]);
      // c1: A B C — c2 appends D (line 2 untouched) — c3 rewrites line 2.
      provider.fileAtRefResult = (path, ref) =>
        text(
          path,
          `blob-${ref}`,
          ref === 'c3' ? 'A\nX\nC\nD\n' : ref === 'c2' ? 'A\nB\nC\nD\n' : 'A\nB\nC\n',
        );

      await store.openFile('README.md', 'c3');
      await store.startLineTrace('README.md', 'c3', { start: 2, end: 2 });

      const state = store.lineTrace();
      expect(state?.status).toBe('ready');
      expect(state?.truncated).toBe(false);
      // c2 only appended a line below the range — filtered out; c1 (the
      // oldest known commit) introduced the file and with it the range.
      expect(traceShas()).toEqual(['c3', 'c1']);
    });

    it('follows same-file moved lines back to their previous position', async () => {
      provider.listCommitsResult = () =>
        Promise.resolve([commit('c3'), commit('c2'), commit('c1')]);
      // c2 moves line B below C without editing it; c3 edits that moved line.
      provider.fileAtRefResult = (path, ref) =>
        text(
          path,
          `blob-${ref}`,
          ref === 'c3' ? 'A\nC\nB changed\n' : ref === 'c2' ? 'A\nC\nB\n' : 'A\nB\nC\n',
        );

      await store.openFile('README.md', 'c3');
      await store.startLineTrace('README.md', 'c3', { start: 3, end: 3 });

      const state = store.lineTrace();
      expect(state?.status).toBe('ready');
      expect(state?.origin).toEqual({ sha: 'c1', range: { start: 2, end: 2 } });
      expect(traceShas()).toEqual(['c3', 'c2', 'c1']);
      expect(traceHits()).toEqual([
        { sha: 'c3', range: { start: 3, end: 3 } },
        { sha: 'c2', range: { start: 3, end: 3 } },
        { sha: 'c1', range: { start: 2, end: 2 } },
      ]);
    });

    it('ends the walk where the traced lines were introduced', async () => {
      provider.listCommitsResult = () =>
        Promise.resolve([commit('c3'), commit('c2'), commit('c1')]);
      // c2 inserted lines 2–3; c3 edited line 2. c1 never contained them.
      provider.fileAtRefResult = (path, ref) =>
        text(
          path,
          `blob-${ref}`,
          ref === 'c3' ? 'A\nN1x\nN2\n' : ref === 'c2' ? 'A\nN1\nN2\n' : 'A\n',
        );

      await store.openFile('README.md', 'c3');
      await store.startLineTrace('README.md', 'c3', { start: 2, end: 2 });

      const state = store.lineTrace();
      expect(state?.status).toBe('ready');
      expect(state?.truncated).toBe(false);
      expect(traceShas()).toEqual(['c3', 'c2']);
    });

    it('keeps a single traced line single across a block rewrite', async () => {
      provider.listCommitsResult = () =>
        Promise.resolve([commit('c3'), commit('c2'), commit('c1'), commit('c0')]);
      // c0 has six lines; c1 edits line 4 (d→D); c2 rewrites the whole middle
      // block (b,c,D,e) into P,Q; c3 edits the first of those (P→P2). Tracing
      // line 2 must keep following a single line — not balloon to the whole
      // replaced block, which would also wrongly flag c1 (it touched line 4).
      provider.fileAtRefResult = (path, ref) =>
        text(
          path,
          `blob-${ref}`,
          ref === 'c3'
            ? 'a\nP2\nQ\nf\n'
            : ref === 'c2'
              ? 'a\nP\nQ\nf\n'
              : ref === 'c1'
                ? 'a\nb\nc\nD\ne\nf\n'
                : 'a\nb\nc\nd\ne\nf\n',
        );

      await store.openFile('README.md', 'c3');
      await store.startLineTrace('README.md', 'c3', { start: 2, end: 2 });

      const state = store.lineTrace();
      expect(state?.status).toBe('ready');
      expect(state?.origin).toEqual({ sha: 'c0', range: { start: 2, end: 2 } });
      // c1 only touched line 4 — it stays out, and every hit is one line.
      expect(traceShas()).toEqual(['c3', 'c2', 'c0']);
      expect(traceHits()).toEqual([
        { sha: 'c3', range: { start: 2, end: 2 } },
        { sha: 'c2', range: { start: 2, end: 2 } },
        { sha: 'c0', range: { start: 2, end: 2 } },
      ]);
    });

    it('keeps a multi-line range its size across a block rewrite', async () => {
      provider.listCommitsResult = () =>
        Promise.resolve([commit('c2'), commit('c1'), commit('c0')]);
      // c1 introduces a four-line block (b,c,d,e); c2 rewrites it into X,Y.
      // Tracing the two-line selection X,Y follows two lines back (2..3), not
      // the block's whole old extent (2..5): a selection keeps its size as it
      // travels through history rather than ballooning (issue #9).
      provider.fileAtRefResult = (path, ref) =>
        text(
          path,
          `blob-${ref}`,
          ref === 'c2' ? 'a\nX\nY\nf\n' : ref === 'c1' ? 'a\nb\nc\nd\ne\nf\n' : 'a\nf\n',
        );

      await store.openFile('README.md', 'c2');
      await store.startLineTrace('README.md', 'c2', { start: 2, end: 3 });

      const state = store.lineTrace();
      expect(state?.status).toBe('ready');
      expect(state?.origin).toEqual({ sha: 'c1', range: { start: 2, end: 3 } });
      expect(traceShas()).toEqual(['c2', 'c1']);
      expect(traceHits()).toEqual([
        { sha: 'c2', range: { start: 2, end: 3 } },
        { sha: 'c1', range: { start: 2, end: 3 } },
      ]);
    });

    it('does not balloon a multi-line range across a near-whole-file rewrite', async () => {
      provider.listCommitsResult = () =>
        Promise.resolve([commit('c2'), commit('c1'), commit('c0')]);
      // c0 already has the lines; c1 rewrites the whole top block (a..g →
      // A..G) — the degenerate diff that broke MemoizR's ReactionBase.cs in
      // issue #9; c2 edits one line inside it (C → C2). Tracing the two-line
      // selection must stay two lines at every commit, never expanding to the
      // whole rewritten block ("the earlier commits select all the lines").
      provider.fileAtRefResult = (path, ref) =>
        text(
          path,
          `blob-${ref}`,
          ref === 'c2'
            ? 'A\nB\nC2\nD\nE\nF\nG\nh\n'
            : ref === 'c1'
              ? 'A\nB\nC\nD\nE\nF\nG\nh\n'
              : 'a\nb\nc\nd\ne\nf\ng\nh\n',
        );

      await store.openFile('README.md', 'c2');
      await store.startLineTrace('README.md', 'c2', { start: 3, end: 4 });

      const state = store.lineTrace();
      expect(state?.status).toBe('ready');
      // Every hit is the two lines that were selected — including across the
      // c1→c0 whole-block rewrite, which previously ballooned to 1..7.
      expect(traceShas()).toEqual(['c2', 'c1', 'c0']);
      expect(traceHits()).toEqual([
        { sha: 'c2', range: { start: 3, end: 4 } },
        { sha: 'c1', range: { start: 3, end: 4 } },
        { sha: 'c0', range: { start: 3, end: 4 } },
      ]);
    });

    it('pauses at the end of the loaded pages and continues on demand', async () => {
      // One full page ⇒ hasMore. Nothing in it touches line 1.
      const pageOne = Array.from({ length: 30 }, (_, i) => commit(`c${i}`));
      provider.listCommitsResult = () => Promise.resolve(pageOne);
      provider.fileAtRefResult = (path, ref) =>
        text(path, `blob-${ref}`, ref === 'c30' ? 'A\n' : 'A\nB\n');

      await store.openFile('README.md', 'c0');
      await store.startLineTrace('README.md', 'c0', { start: 1, end: 1 });

      let state = store.lineTrace();
      expect(state?.status).toBe('ready');
      expect(state?.truncated).toBe(true);
      expect(state?.commits).toEqual([]);

      // The next page ends the history; the walk resumes and finds that
      // c30 created the file (and so introduced line 1). c29's step only
      // added line 2 — still filtered out.
      provider.listCommitsResult = () => Promise.resolve([commit('c30')]);
      await store.extendLineTrace();

      state = store.lineTrace();
      expect(state?.status).toBe('ready');
      expect(state?.truncated).toBe(false);
      expect(traceShas()).toEqual(['c30']);
    });

    it('errors when the anchor is not part of the loaded history', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('c1')]);

      await store.openFile('README.md', 'ghost');
      await store.startLineTrace('README.md', 'ghost', { start: 1, end: 1 });

      expect(store.lineTrace()).toMatchObject({ status: 'error' });
    });

    it('ends the trail at the re-add when the file is absent before it', async () => {
      // README.md was deleted at c2 and re-added at c3 (history lists all three).
      provider.listCommitsResult = () =>
        Promise.resolve([commit('c3'), commit('c2'), commit('c1')]);
      provider.fileAtRefResult = (path, ref) => {
        if (ref === 'c2') {
          return Promise.reject(
            new RepoProviderError(
              `"${path}" does not exist at c2 — deleted by this commit.`,
              'not-found',
            ),
          );
        }
        return text(path, `blob-${ref}`, 'A\nB\n');
      };

      await store.openFile('README.md', 'c3');
      await store.startLineTrace('README.md', 'c3', { start: 1, end: 1 });

      const state = store.lineTrace();
      // The gap at c2 ends the trail at the re-add (c3) instead of erroring.
      expect(state?.status).toBe('ready');
      expect(state?.truncated).toBe(false);
      expect(state?.origin).toEqual({ sha: 'c3', range: { start: 1, end: 1 } });
      expect(traceShas()).toEqual(['c3']);
    });

    it('survives time travel within the file but not a file switch', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('c2'), commit('c1')]);
      provider.fileAtRefResult = (path, ref) =>
        text(path, `blob-${ref}`, ref === 'c2' ? 'A\nB\n' : 'A\n');

      await store.openFile('README.md', 'c2');
      await store.startLineTrace('README.md', 'c2', { start: 1, end: 1 });
      expect(store.lineTrace()?.status).toBe('ready');

      await store.openFile('README.md', 'c1');
      expect(store.lineTrace()).not.toBeNull();

      await store.openFile('src/deep/main.ts');
      expect(store.lineTrace()).toBeNull();
    });

    it('is cleared by a new repository load', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('c1')]);
      await store.openFile('README.md', 'c1');
      await store.startLineTrace('README.md', 'c1', { start: 1, end: 1 });
      expect(store.lineTrace()).not.toBeNull();

      await store.loadRepo({ provider: 'github', owner: 'other', repo: 'repo' });

      expect(store.lineTrace()).toBeNull();
    });
  });

  describe('hunk origin search (searchTraceOrigins)', () => {
    beforeEach(async () => {
      await store.loadRepo(slug);
    });

    function text(path: string, sha: string, content: string): Promise<RepoFile> {
      return Promise.resolve({ kind: 'text', path, sha, size: content.length, text: content });
    }

    /** Traces README lines 2–3, which c2 (repo parent: c1) introduced. */
    async function traceIntroducedBlock(): Promise<void> {
      provider.listCommitsResult = () => Promise.resolve([commit('c2', ['c1']), commit('c1', [])]);
      provider.fileAtRefResult = (path, ref) => {
        if (path === 'README.md') {
          return text(
            path,
            `blob-${ref}`,
            ref === 'c2' ? 'A\nalpha block line\nbeta block line\n' : 'A\n',
          );
        }
        // The moved block's source, as it was at the parent commit c1.
        return text(
          path,
          `blob-${ref}`,
          'header line\nalpha block line\nbeta block line\nfooter line\n',
        );
      };
      await store.openFile('README.md', 'c2');
      await store.startLineTrace('README.md', 'c2', { start: 2, end: 3 });
    }

    it('records where the trace ended', async () => {
      await traceIntroducedBlock();

      expect(store.lineTrace()).toMatchObject({
        status: 'ready',
        origin: { sha: 'c2', range: { start: 2, end: 3 } },
      });
    });

    it('finds the source among the files the commit touched', async () => {
      await traceIntroducedBlock();
      provider.commitFilesResult = () =>
        Promise.resolve([
          { path: 'README.md', status: 'modified' },
          { path: 'src/old.ts', status: 'removed' },
        ]);

      await store.searchTraceOrigins('commit');

      const state = store.traceOrigins();
      expect(state?.status).toBe('ready');
      // src/old.ts is 4 lines, the traced file 3, sharing the 2 block lines →
      // whole-file similarity 2/4 = 0.5, alongside the exact (1.0) block match.
      expect(state?.candidates).toEqual([
        {
          path: 'src/old.ts',
          line: 2,
          score: 1,
          fileSimilarity: 0.5,
          deleted: true,
          parentSha: 'c1',
        },
      ]);
    });

    it('ranks a more file-similar source above an equally-matched one', async () => {
      await traceIntroducedBlock();
      provider.commitFilesResult = () =>
        Promise.resolve([
          { path: 'README.md', status: 'modified' },
          { path: 'src/near.ts', status: 'removed' },
          { path: 'src/far.ts', status: 'removed' },
        ]);
      // Both hold the exact block (score 1), but near.ts is otherwise the
      // traced file's twin while far.ts is padded with unrelated lines, so the
      // whole-file similarity is what tells them apart and orders them.
      provider.fileAtRefResult = (path, ref) => {
        if (path === 'src/far.ts') {
          return text(
            path,
            `blob-${ref}`,
            'x1\nx2\nx3\nalpha block line\nbeta block line\nx4\nx5\n',
          );
        }
        return text(path, `blob-${ref}`, 'A\nalpha block line\nbeta block line\n');
      };

      await store.searchTraceOrigins('commit');

      const candidates = store.traceOrigins()?.candidates ?? [];
      expect(candidates.map((c) => c.path)).toEqual(['src/near.ts', 'src/far.ts']);
      expect(candidates.map((c) => c.score)).toEqual([1, 1]);
      expect(candidates[0].fileSimilarity).toBe(1);
      expect(candidates[1].fileSimilarity).toBeLessThan(1);
    });

    it('widens to the whole snapshot on demand', async () => {
      await traceIntroducedBlock();
      provider.commitFilesResult = () =>
        Promise.resolve([{ path: 'README.md', status: 'modified' }]);
      provider.treeResult = (ref) =>
        ref === 'c1'
          ? Promise.resolve({
              truncated: false,
              entries: [
                { path: 'README.md', name: 'README.md', kind: 'file', sha: 'r0', size: 2 },
                { path: 'src/old.ts', name: 'old.ts', kind: 'file', sha: 'o1', size: 40 },
              ],
            })
          : Promise.resolve({ entries, truncated: false });

      await store.searchTraceOrigins('commit');
      expect(store.traceOrigins()).toMatchObject({ status: 'ready', candidates: [] });

      await store.searchTraceOrigins('snapshot');
      const state = store.traceOrigins();
      expect(state?.status).toBe('ready');
      expect(state?.candidates).toMatchObject([{ path: 'src/old.ts', line: 2, deleted: false }]);
      // The traced file itself is never searched.
      expect(state?.total).toBe(1);
    });

    it('is unavailable when the introducing commit is the root', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('c1', [])]);
      provider.fileAtRefResult = (path, ref) => text(path, `blob-${ref}`, 'A\n');
      await store.openFile('README.md', 'c1');
      await store.startLineTrace('README.md', 'c1', { start: 1, end: 1 });
      expect(store.lineTrace()?.origin).toEqual({ sha: 'c1', range: { start: 1, end: 1 } });

      await store.searchTraceOrigins('commit');

      expect(store.traceOrigins()).toMatchObject({ status: 'unavailable' });
    });

    it('is cleared with the trace', async () => {
      await traceIntroducedBlock();
      provider.commitFilesResult = () =>
        Promise.resolve([{ path: 'src/old.ts', status: 'removed' }]);
      await store.searchTraceOrigins('commit');
      expect(store.traceOrigins()).not.toBeNull();

      store.clearLineTrace();

      expect(store.traceOrigins()).toBeNull();
    });
  });

  describe('rename candidates (loadRenameCandidates)', () => {
    function parentTree(): RepoTree {
      return {
        truncated: false,
        entries: [
          { path: 'docs', name: 'docs', kind: 'dir', sha: 'd1' },
          // Same blob sha as README at its creation → identical content.
          { path: 'docs/old-name.md', name: 'old-name.md', kind: 'file', sha: 'BLOB0', size: 12 },
          // Reported by the provider's rename detection.
          {
            path: 'docs/renamed-from.md',
            name: 'renamed-from.md',
            kind: 'file',
            sha: 'R1',
            size: 12,
          },
          // Same extension + similar size + similar content at the root.
          { path: 'SIMILAR.md', name: 'SIMILAR.md', kind: 'file', sha: 'S1', size: 13 },
          // Should not surface: different in every respect.
          { path: 'unrelated.bin', name: 'unrelated.bin', kind: 'file', sha: 'U1', size: 90000 },
        ],
      };
    }

    beforeEach(async () => {
      await store.loadRepo(slug);
      provider.listCommitsResult = () => Promise.resolve([commit('create', ['parent'])]);
      provider.fileAtRefResult = (path, ref) =>
        Promise.resolve({
          kind: 'text',
          path,
          sha: path === 'README.md' ? 'BLOB0' : `c-${path}`,
          size: 12,
          text: path === 'SIMILAR.md' ? 'line1\nline2\nline3\n' : 'line1\nline2\n',
        });
      provider.treeResult = (ref) =>
        ref === 'parent'
          ? Promise.resolve(parentTree())
          : Promise.resolve({ entries, truncated: false });
      provider.commitFilesResult = () =>
        Promise.resolve([
          { path: 'README.md', status: 'renamed', previousPath: 'docs/renamed-from.md' },
        ]);
      await store.openFile('README.md');
      await store.loadHistory('README.md');
    });

    it('ranks provider renames, identical blobs and similar files', async () => {
      await store.loadRenameCandidates('README.md');

      const state = store.selectedRenames();
      expect(state?.status).toBe('ready');
      if (state?.status !== 'ready') return;
      expect(state.parentSha).toBe('parent');
      expect(state.endCommit.sha).toBe('create');

      const byPath = new Map(state.candidates.map((c) => [c.path, c]));
      expect(byPath.get('docs/old-name.md')).toMatchObject({
        confidence: 1,
        reasons: ['identical-content'],
      });
      expect(byPath.get('docs/renamed-from.md')?.reasons).toContain('github-rename');
      const similar = byPath.get('SIMILAR.md');
      expect(similar?.reasons).toContain('similar-content');
      expect(similar!.confidence).toBeGreaterThan(0.6);
      expect(byPath.has('unrelated.bin')).toBe(false);
      // Sorted by confidence, identical first.
      expect(state.candidates[0].path).toBe('docs/old-name.md');
    });

    it('caches the result and does not rerun the search', async () => {
      await store.loadRenameCandidates('README.md');
      const treeCallsAfterFirst = provider.treeCalls;
      await store.loadRenameCandidates('README.md');

      expect(provider.treeCalls).toBe(treeCallsAfterFirst);
    });

    it('is unavailable when the file was created in the first commit', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('root', [])]);
      await store.loadRepo(slug, undefined, { force: true });
      await store.openFile('README.md');
      await store.loadHistory('README.md');

      await store.loadRenameCandidates('README.md');

      expect(store.selectedRenames()).toMatchObject({ status: 'unavailable' });
    });

    it('does nothing while the history is incomplete', async () => {
      const fullPage = Array.from({ length: 30 }, (_, i) => commit(`c${i}`, [`c${i + 1}`]));
      provider.listCommitsResult = () => Promise.resolve(fullPage);
      await store.loadRepo(slug, undefined, { force: true });
      await store.openFile('README.md');
      await store.loadHistory('README.md');

      await store.loadRenameCandidates('README.md');

      expect(store.selectedRenames()).toBeNull();
    });

    it('ranks files the creating commit deleted by fuzzy content similarity', async () => {
      provider.commitFilesResult = () =>
        Promise.resolve([
          { path: 'README.md', status: 'added' },
          { path: 'docs/legacy.md', status: 'removed' },
        ]);
      provider.treeResult = (ref) =>
        ref === 'parent'
          ? Promise.resolve({
              truncated: false,
              entries: [
                { path: 'docs', name: 'docs', kind: 'dir', sha: 'd1' },
                { path: 'docs/legacy.md', name: 'legacy.md', kind: 'file', sha: 'L1', size: 13 },
              ],
            })
          : Promise.resolve({ entries, truncated: false });
      // README at creation is 'line1\nline2\n'; the deleted file differs by
      // one character in line 2 — exact-line similarity would see only 50%.
      provider.fileAtRefResult = (path) =>
        Promise.resolve({
          kind: 'text',
          path,
          sha: path === 'README.md' ? 'BLOB0' : `c-${path}`,
          size: 12,
          text: path === 'docs/legacy.md' ? 'line1\nline2x\n' : 'line1\nline2\n',
        });

      await store.loadRenameCandidates('README.md');

      const state = store.selectedRenames();
      expect(state?.status).toBe('ready');
      if (state?.status !== 'ready') return;
      const legacy = state.candidates.find((c) => c.path === 'docs/legacy.md');
      expect(legacy?.reasons).toContain('deleted-in-commit');
      expect(legacy?.reasons).toContain('similar-content');
      expect(legacy!.confidence).toBeGreaterThan(0.85);
      // The deleted file outranks every generic heuristic candidate.
      expect(state.candidates[0].path).toBe('docs/legacy.md');
    });
  });

  describe('lastTouch', () => {
    it('returns the most recent commit touching a path before a ref', async () => {
      await store.loadRepo(slug);
      provider.listCommitsResult = () => Promise.resolve([commit('g1')]);

      const result = await store.lastTouch('docs/renamed-from.md', 'parent');

      expect(result?.sha).toBe('g1');
      expect(provider.listCommitsCalls.at(-1)).toEqual({
        ref: 'parent',
        path: 'docs/renamed-from.md',
        perPage: 1,
      });
    });

    it('resolves null when nothing touched the path', async () => {
      await store.loadRepo(slug);
      provider.listCommitsResult = () => Promise.resolve([]);

      await expect(store.lastTouch('nope.md', 'parent')).resolves.toBeNull();
    });
  });

  describe('folder ownership (computeFolderOwnership)', () => {
    beforeEach(async () => {
      await store.loadRepo(slug);
    });

    it("aggregates authorship across the folder's files", async () => {
      // A single-commit history attributes every line to that commit's author.
      provider.listCommitsResult = () => Promise.resolve([commit('c1')]);

      await store.computeFolderOwnership('');

      const state = store.folderOwnership();
      expect(state?.status).toBe('ready');
      expect(state?.path).toBe('');
      // Two files under the root (README.md and the nested src/deep/main.ts).
      expect(state?.filesTotal).toBe(2);
      expect(state?.filesScanned).toBe(2);
      expect(state?.matchedTotal).toBe(2);
      expect(state?.capped).toBe(false);
      // Largest first: src/deep/main.ts (size 10) before README.md (size 5).
      expect(state?.files).toEqual(['src/deep/main.ts', 'README.md']);
      expect(state?.summary.attributedLines).toBe(2); // one content line per file
      expect(state?.summary.authors).toEqual([
        expect.objectContaining({ name: 'Ada', lines: 2, share: 1 }),
      ]);
      expect(state?.summary.busFactor).toBe(1);
    });

    it('scans every file uncapped when asked to load all', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('c1')]);

      await store.computeFolderOwnership('', { all: true });

      const state = store.folderOwnership();
      expect(state?.status).toBe('ready');
      expect(state?.capped).toBe(false);
      expect(state?.filesScanned).toBe(state?.matchedTotal);
      expect(state?.files).toEqual(['src/deep/main.ts', 'README.md']);
    });

    it('scans recursively under a subfolder', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('c1')]);

      await store.computeFolderOwnership('src');

      const state = store.folderOwnership();
      expect(state?.status).toBe('ready');
      expect(state?.filesTotal).toBe(1); // only the nested src/deep/main.ts
      expect(state?.summary.attributedLines).toBe(1);
    });

    it('primes every path history once before blaming the files', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('c1')]);

      await store.computeFolderOwnership('');

      // One bulk precompute for the active ref, instead of a per-file walk storm.
      expect(provider.primeHistoriesCalls).toEqual(['main']);
      expect(store.folderOwnership()?.status).toBe('ready');
    });

    it('cancels an in-flight scan when cleared', async () => {
      const pending = deferred<CommitInfo[]>();
      provider.listCommitsResult = () => pending.promise;

      const scan = store.computeFolderOwnership('');
      expect(store.folderOwnership()?.status).toBe('computing');

      store.clearFolderOwnership();
      pending.resolve([commit('c1')]);
      await scan;

      expect(store.folderOwnership()).toBeNull();
    });

    it('folds the folder chart from cached blame, with no scan and no requests', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('c1')]);

      // Nothing blamed yet: the chart cannot be shown for free.
      expect(store.folderOwnershipFromCache('')).toBeNull();

      // Blaming one of the two root files is not enough on its own.
      await store.loadBlame('src/deep/main.ts', null);
      expect(store.folderOwnershipFromCache('')).toBeNull();

      // Once every file the scan would cover is blamed, the summary is ready —
      // built purely from cache, marked so the panel knows it wasn't scanned.
      await store.loadBlame('README.md', null);
      const cached = store.folderOwnershipFromCache('');
      expect(cached?.status).toBe('ready');
      expect(cached?.fromCache).toBe(true);
      expect(cached?.filesScanned).toBe(2);
      expect(cached?.summary.authors).toEqual([
        expect.objectContaining({ name: 'Ada', lines: 2, share: 1 }),
      ]);

      // It read the blame cache only — no extra commit/file scan was kicked off.
      expect(store.folderOwnership()).toBeNull();
    });
  });

  describe('co-change (computeCoChange)', () => {
    beforeEach(async () => {
      await store.loadRepo(slug);
    });

    it('walks recent commits and couples files that change together', async () => {
      provider.listCommitsResult = () =>
        Promise.resolve([commit('c1'), commit('c2'), commit('c3')]);
      provider.commitFilesResult = (sha) =>
        Promise.resolve(
          sha === 'c3'
            ? [
                { path: 'a.ts', status: 'modified' },
                { path: 'c.ts', status: 'modified' },
              ]
            : [
                { path: 'a.ts', status: 'modified' },
                { path: 'b.ts', status: 'modified' },
              ],
        );

      await store.computeCoChange();

      const state = store.coChange();
      expect(state?.status).toBe('ready');
      expect(state?.result.commitsUsed).toBe(3);
      // a.ts↔b.ts in c1 & c2 (support 2); a.ts↔c.ts only once (dropped).
      expect(state?.result.pairs.map((p) => `${p.a}-${p.b}`)).toEqual(['a.ts-b.ts']);
      // The same walk ranks hotspots: a.ts changed in all 3 commits.
      expect(state?.hotspots[0]?.path).toBe('a.ts');
      expect(state?.hotspots[0]?.metric.revisions).toBe(3);
    });

    it('excludes generated/vendored files from the metrics', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('c1'), commit('c2')]);
      provider.commitFilesResult = () =>
        Promise.resolve([
          { path: 'src/deep/main.ts', status: 'modified' }, // a real, in-tree source file
          { path: 'package-lock.json', status: 'modified' },
          { path: 'dist/bundle.js', status: 'modified' },
        ]);

      await store.computeCoChange();

      const state = store.coChange();
      expect(state?.status).toBe('ready');
      // Only the authored source file survives into the metrics…
      expect(state?.hotspots.map((h) => h.path)).toEqual(['src/deep/main.ts']);
      expect(state?.knowledge.files.map((f) => f.path)).toEqual(['src/deep/main.ts']);
      // …and the two generated files are reported as held out.
      expect(state?.excludedFiles).toBe(2);
    });

    it('reports a walk complete when history is exhausted exactly at the cap', async () => {
      // 75 commits (= CO_CHANGE_COMMIT_CAP) delivered as 30 + 30 + 15; the short
      // final page marks the end of history, so the result must not be partial.
      const pages = [
        Array.from({ length: 30 }, (_, i) => commit(`a${i}`)),
        Array.from({ length: 30 }, (_, i) => commit(`b${i}`)),
        Array.from({ length: 15 }, (_, i) => commit(`c${i}`)),
      ];
      let call = 0;
      provider.listCommitsResult = () => Promise.resolve(pages[call++] ?? []);
      provider.commitFilesResult = () =>
        Promise.resolve([{ path: 'src/app.ts', status: 'modified' }]);

      await store.computeCoChange();

      const state = store.coChange();
      expect(state?.status).toBe('ready');
      expect(state?.scanned).toBe(75);
      expect(state?.knowledge.partial).toBe(false);
    });

    it('stays partial when the cap stops partway through a short final page', async () => {
      // 80 commits as 30 + 30 + 20, cap 75: the final page is short, but the cap
      // halts the walk after only 15 of its 20 commits — 5 remain unread, so the
      // result is still partial despite the short page.
      const pages = [
        Array.from({ length: 30 }, (_, i) => commit(`a${i}`)),
        Array.from({ length: 30 }, (_, i) => commit(`b${i}`)),
        Array.from({ length: 20 }, (_, i) => commit(`c${i}`)),
      ];
      let call = 0;
      provider.listCommitsResult = () => Promise.resolve(pages[call++] ?? []);
      provider.commitFilesResult = () =>
        Promise.resolve([{ path: 'src/app.ts', status: 'modified' }]);

      await store.computeCoChange();

      const state = store.coChange();
      expect(state?.status).toBe('ready');
      expect(state?.scanned).toBe(75);
      expect(state?.knowledge.partial).toBe(true);
    });

    it('reports a walk partial when it stops at the cap with history remaining', async () => {
      // Every page is full, so the walk fills the cap without ever seeing the end.
      let call = 0;
      provider.listCommitsResult = () => {
        const page = Array.from({ length: 30 }, (_, i) => commit(`p${call}c${i}`));
        call++;
        return Promise.resolve(page);
      };
      provider.commitFilesResult = () =>
        Promise.resolve([{ path: 'src/app.ts', status: 'modified' }]);

      await store.computeCoChange();

      const state = store.coChange();
      expect(state?.status).toBe('ready');
      expect(state?.scanned).toBe(75);
      expect(state?.knowledge.partial).toBe(true);
    });

    it('drops files deleted from the current tree from the knowledge risk', async () => {
      // src/deep/main.ts is in the tree; src/gone.ts is not (deleted in this branch).
      provider.listCommitsResult = () => Promise.resolve([commit('c1'), commit('c2')]);
      provider.commitFilesResult = () =>
        Promise.resolve([
          { path: 'src/deep/main.ts', status: 'modified' },
          { path: 'src/gone.ts', status: 'modified' },
        ]);

      await store.computeCoChange();

      const paths = store.coChange()?.knowledge.files.map((f) => f.path);
      expect(paths).toContain('src/deep/main.ts');
      expect(paths).not.toContain('src/gone.ts');
    });

    it('surfaces related files for the selected file', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('c1'), commit('c2')]);
      provider.commitFilesResult = () =>
        Promise.resolve([
          { path: 'README.md', status: 'modified' },
          { path: 'src/deep/main.ts', status: 'modified' },
        ]);

      await store.openFile('README.md');
      await store.computeCoChange();

      expect(store.selectedRelated().map((r) => r.path)).toEqual(['src/deep/main.ts']);
    });

    it('cancels an in-flight walk when cleared', async () => {
      const pending = deferred<CommitInfo[]>();
      provider.listCommitsResult = () => pending.promise;

      const walk = store.computeCoChange();
      expect(store.coChange()?.status).toBe('computing');

      store.clearCoChange();
      pending.resolve([commit('c1')]);
      await walk;

      expect(store.coChange()).toBeNull();
    });

    it('does not resurrect state if a cleared walk later rejects', async () => {
      const pending = deferred<CommitInfo[]>();
      provider.listCommitsResult = () => pending.promise;

      const walk = store.computeCoChange();
      store.clearCoChange();
      pending.reject(new RepoProviderError('boom', 'network'));
      await walk;

      expect(store.coChange()).toBeNull();
    });

    it('walks the full history when asked to load all commits', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('c1')]);
      provider.commitFilesResult = () => Promise.resolve([{ path: 'a.ts', status: 'modified' }]);

      await store.computeCoChange({ all: true });

      // No commit cap: the walk targets the whole history (infinite).
      expect(store.coChange()?.target).toBe(Number.POSITIVE_INFINITY);
      expect(store.coChange()?.status).toBe('ready');
    });

    it('focuses a single file’s full history, keeping low-support couplings', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('c1'), commit('c2')]);
      provider.commitFilesResult = (sha) =>
        Promise.resolve(
          sha === 'c2'
            ? [
                { path: 'README.md', status: 'modified' },
                { path: 'rare.ts', status: 'modified' },
              ]
            : [
                { path: 'README.md', status: 'modified' },
                { path: 'src/deep/main.ts', status: 'modified' },
              ],
        );

      await store.computeCoChangeFor('README.md');

      // The file filter publishes to its own signal, not the repo-wide overview.
      const state = store.coupleFocus();
      expect(state?.focus).toBe('README.md');
      expect(state?.status).toBe('ready');
      // minSupport 1 in focus mode, so even the single co-change is kept.
      const partners = state!.result.pairs
        .filter((p) => p.a === 'README.md' || p.b === 'README.md')
        .map((p) => (p.a === 'README.md' ? p.b : p.a))
        .sort();
      expect(partners).toEqual(['rare.ts', 'src/deep/main.ts']);
    });

    it('keeps the overview when a file filter is applied and then cleared', async () => {
      provider.listCommitsResult = () => Promise.resolve([commit('c1')]);
      provider.commitFilesResult = () =>
        Promise.resolve([
          { path: 'README.md', status: 'modified' },
          { path: 'src/deep/main.ts', status: 'modified' },
        ]);

      await store.computeCoChange();
      expect(store.coChange()?.status).toBe('ready');

      await store.computeCoChangeFor('README.md');
      // The filter is set; the repo-wide overview survives alongside it.
      expect(store.coupleFocus()?.focus).toBe('README.md');
      expect(store.coChange()?.status).toBe('ready');

      store.clearCoupleFocus();
      // Only the filter is dropped — the overview is still there.
      expect(store.coupleFocus()).toBeNull();
      expect(store.coChange()?.status).toBe('ready');
    });
  });

  describe('code survival (computeSurvival)', () => {
    /** A three-commit history that adds, edits and trims one file. */
    function scriptSurvivalHistory(): void {
      const mk = (
        sha: string,
        authorName: string,
        authoredAt: string,
        parents: string[],
      ): CommitInfo => ({
        sha,
        message: sha,
        summary: sha,
        authorName,
        authorEmail: null,
        authoredAt,
        htmlUrl: `https://github.com/acme/rocket/commit/${sha}`,
        parentShas: parents,
      });
      // c1 Ada adds 3 lines · c2 Bob edits L2 and appends L4 · c3 Ada drops L4.
      const c1 = mk('c1', 'Ada', '2024-01-01T00:00:00Z', []);
      const c2 = mk('c2', 'Bob', '2024-06-01T00:00:00Z', ['c1']);
      const c3 = mk('c3', 'Ada', '2025-01-01T00:00:00Z', ['c2']);
      provider.listCommitsResult = () => Promise.resolve([c3, c2, c1]); // newest first
      provider.commitFilesResult = (sha) =>
        Promise.resolve([{ path: 'a.txt', status: sha === 'c1' ? 'added' : 'modified' }]);
      const text: Record<string, string> = {
        c1: 'L1\nL2\nL3\n',
        c2: 'L1\nL2x\nL3\nL4\n',
        c3: 'L1\nL2x\nL3\n',
      };
      provider.fileAtRefResult = (path, ref) =>
        Promise.resolve({
          kind: 'text',
          path,
          sha: `blob-${ref}`,
          size: text[ref].length,
          text: text[ref],
        });
    }

    it('tracks line births and deaths into cohorts, authorship and a survival curve', async () => {
      scriptSurvivalHistory();
      await store.loadRepo(slug);

      await store.computeSurvival();

      const state = store.survival();
      expect(state?.status).toBe('ready');
      const report = state!.report;
      // Surviving lines at the tip: L1 (Ada), L2x (Bob), L3 (Ada).
      expect(report.aliveLines).toBe(3);
      // Deaths: L2 (Ada) at c2, L4 (Bob) at c3.
      expect(report.curve.deaths).toBe(2);
      expect(report.curve.censored).toBe(3);
      expect(report.trackedLines).toBe(5);
      // "% of code by author" counts only the lines alive today.
      expect(report.authors).toEqual([
        { author: 'Ada', lines: 2, share: 2 / 3 },
        { author: 'Bob', lines: 1, share: 1 / 3 },
      ]);
    });

    it('clears the survival analysis on demand', async () => {
      scriptSurvivalHistory();
      await store.loadRepo(slug);
      await store.computeSurvival();
      expect(store.survival()).not.toBeNull();

      store.clearSurvival();
      expect(store.survival()).toBeNull();
    });

    it('reports an empty history without error', async () => {
      provider.listCommitsResult = () => Promise.resolve([]);
      await store.loadRepo(slug);

      await store.computeSurvival();

      expect(store.survival()?.status).toBe('ready');
      expect(store.survival()?.report.trackedLines).toBe(0);
    });

    it('surfaces a provider error mid-walk instead of a corrupted ready report', async () => {
      scriptSurvivalHistory();
      // c1 succeeds, then c2's file list fails (e.g. a rate limit): the walk must
      // fail loudly, not silently drop that commit and publish a "ready" report.
      provider.commitFilesResult = (sha) =>
        sha === 'c2'
          ? Promise.reject(new RepoProviderError('rate limited', 'rate-limited'))
          : Promise.resolve([{ path: 'a.txt', status: sha === 'c1' ? 'added' : 'modified' }]);
      await store.loadRepo(slug);

      await store.computeSurvival();

      expect(store.survival()?.status).toBe('error');
      expect(store.survival()?.message).toContain('rate limited');
    });

    it('fails the walk on a non-not-found blob error rather than recording false deaths', async () => {
      scriptSurvivalHistory();
      provider.fileAtRefResult = (path, ref) =>
        ref === 'c2'
          ? Promise.reject(new RepoProviderError('network down', 'network'))
          : Promise.resolve({ kind: 'text', path, sha: ref, size: 6, text: 'L1\nL2\nL3\n' });
      await store.loadRepo(slug);

      await store.computeSurvival();

      expect(store.survival()?.status).toBe('error');
    });

    it('counts a copied file as new births, leaving the source intact', async () => {
      const mk = (sha: string, authorName: string, authoredAt: string): CommitInfo => ({
        sha,
        message: sha,
        summary: sha,
        authorName,
        authorEmail: null,
        authoredAt,
        htmlUrl: `https://github.com/acme/rocket/commit/${sha}`,
        parentShas: sha === 'c1' ? [] : ['c1'],
      });
      provider.listCommitsResult = () =>
        Promise.resolve([
          mk('c2', 'Bob', '2024-06-01T00:00:00Z'),
          mk('c1', 'Ada', '2024-01-01T00:00:00Z'),
        ]);
      // c1 Ada adds a.txt; c2 Bob copies it to b.txt (a.txt untouched).
      provider.commitFilesResult = (sha) =>
        Promise.resolve(
          sha === 'c1'
            ? [{ path: 'a.txt', status: 'added' }]
            : [{ path: 'b.txt', status: 'copied', previousPath: 'a.txt' }],
        );
      provider.fileAtRefResult = (path) =>
        Promise.resolve({ kind: 'text', path, sha: `blob-${path}`, size: 6, text: 'L1\nL2\n' });
      await store.loadRepo(slug);

      await store.computeSurvival();

      const report = store.survival()!.report;
      expect(report.curve.deaths).toBe(0); // a copy kills nothing
      expect(report.aliveLines).toBe(4); // a.txt (Ada) + b.txt (Bob), 2 lines each
      // The copy's lines are Bob's new births, not inherited from Ada.
      expect(report.authors).toEqual([
        { author: 'Ada', lines: 2, share: 0.5 },
        { author: 'Bob', lines: 2, share: 0.5 },
      ]);
    });

    it('resolves omitted parents to build the first-parent chain (Azure-style lists)', async () => {
      const mk = (
        sha: string,
        authorName: string,
        authoredAt: string,
        parents: string[],
      ): CommitInfo => ({
        sha,
        message: sha,
        summary: sha,
        authorName,
        authorEmail: null,
        authoredAt,
        htmlUrl: `https://github.com/acme/rocket/commit/${sha}`,
        parentShas: parents,
      });
      // The list omits parents (like Azure DevOps); getCommit fills them in.
      provider.listCommitsResult = () =>
        Promise.resolve([
          mk('c3', 'Ada', '2025-01-01T00:00:00Z', []),
          mk('c2', 'Bob', '2024-06-01T00:00:00Z', []),
          mk('c1', 'Ada', '2024-01-01T00:00:00Z', []),
        ]);
      provider.commitResult = (sha) =>
        Promise.resolve(
          sha === 'c3'
            ? mk('c3', 'Ada', '2025-01-01T00:00:00Z', ['c2'])
            : sha === 'c2'
              ? mk('c2', 'Bob', '2024-06-01T00:00:00Z', ['c1'])
              : mk('c1', 'Ada', '2024-01-01T00:00:00Z', []),
        );
      provider.commitFilesResult = (sha) =>
        Promise.resolve([{ path: 'a.txt', status: sha === 'c1' ? 'added' : 'modified' }]);
      const text: Record<string, string> = {
        c1: 'L1\nL2\nL3\n',
        c2: 'L1\nL2x\nL3\nL4\n',
        c3: 'L1\nL2x\nL3\n',
      };
      provider.fileAtRefResult = (path, ref) =>
        Promise.resolve({
          kind: 'text',
          path,
          sha: `blob-${ref}`,
          size: text[ref].length,
          text: text[ref],
        });
      await store.loadRepo(slug);

      await store.computeSurvival();

      const report = store.survival()!.report;
      // Same outcome as the parents-present case — proof the chain was rebuilt.
      expect(report.aliveLines).toBe(3);
      expect(report.curve.deaths).toBe(2);
      expect(provider.getCommitCalls).toContain('c3'); // parents were resolved on demand
    });

    it('clamps backdated commits so a death is never recorded before its birth', async () => {
      const mk = (sha: string, authoredAt: string, parents: string[]): CommitInfo => ({
        sha,
        message: sha,
        summary: sha,
        authorName: 'Ada',
        authorEmail: null,
        authoredAt,
        htmlUrl: `https://github.com/acme/rocket/commit/${sha}`,
        parentShas: parents,
      });
      // base.txt (2020) spreads the time axis; a.txt is added in c1 (Jun 2024) and
      // removed in c2 — a child of c1 but **backdated** to Jan 2024.
      provider.listCommitsResult = () =>
        Promise.resolve([
          mk('c2', '2024-01-01T00:00:00Z', ['c1']),
          mk('c1', '2024-06-01T00:00:00Z', ['c0']),
          mk('c0', '2020-01-01T00:00:00Z', []),
        ]);
      provider.commitFilesResult = (sha) =>
        Promise.resolve(
          sha === 'c0'
            ? [{ path: 'base.txt', status: 'added' }]
            : sha === 'c1'
              ? [{ path: 'a.txt', status: 'added' }]
              : [{ path: 'a.txt', status: 'removed' }],
        );
      const blobs: Record<string, string> = { 'base.txt@c0': 'B\n', 'a.txt@c1': 'L\n' };
      provider.fileAtRefResult = (path, ref) => {
        const text = blobs[`${path}@${ref}`];
        return text === undefined
          ? Promise.reject(new RepoProviderError('absent', 'not-found'))
          : Promise.resolve({ kind: 'text', path, sha: `${path}-${ref}`, size: text.length, text });
      };
      await store.loadRepo(slug);

      await store.computeSurvival();

      const report = store.survival()!.report;
      expect(report.curve.deaths).toBe(1); // a.txt's line died (clamped to its birth time)
      expect(report.aliveLines).toBe(1); // base.txt survives
      // The clamp keeps every cohort count non-negative (diedAt ≥ bornAt throughout).
      const allNonNegative = report.cohorts.bands.every((band) =>
        report.cohorts.counts.get(band)!.every((count) => count >= 0),
      );
      expect(allNonNegative).toBe(true);
    });

    it('keeps a rename and a same-commit re-creation of the source path distinct', async () => {
      const mk = (
        sha: string,
        authorName: string,
        authoredAt: string,
        parents: string[],
      ): CommitInfo => ({
        sha,
        message: sha,
        summary: sha,
        authorName,
        authorEmail: null,
        authoredAt,
        htmlUrl: `https://github.com/acme/rocket/commit/${sha}`,
        parentShas: parents,
      });
      provider.listCommitsResult = () =>
        Promise.resolve([
          mk('c2', 'Bob', '2024-06-01T00:00:00Z', ['c1']),
          mk('c1', 'Ada', '2024-01-01T00:00:00Z', []),
        ]);
      // c2 renames a.txt → b.txt AND adds a fresh a.txt (the new file listed first).
      provider.commitFilesResult = (sha) =>
        Promise.resolve(
          sha === 'c1'
            ? [{ path: 'a.txt', status: 'added' }]
            : [
                { path: 'a.txt', status: 'added' },
                { path: 'b.txt', status: 'renamed', previousPath: 'a.txt' },
              ],
        );
      const blobs: Record<string, string> = {
        'a.txt@c1': 'A1\nA2\n',
        'b.txt@c2': 'A1\nA2\n', // the renamed content
        'a.txt@c2': 'X\n', // the new file at the old path
      };
      provider.fileAtRefResult = (path, ref) => {
        const text = blobs[`${path}@${ref}`];
        return text === undefined
          ? Promise.reject(new RepoProviderError('absent', 'not-found'))
          : Promise.resolve({ kind: 'text', path, sha: `${path}-${ref}`, size: text.length, text });
      };
      await store.loadRepo(slug);

      await store.computeSurvival();

      const report = store.survival()!.report;
      expect(report.curve.deaths).toBe(0); // the rename carried A1/A2; nothing died
      expect(report.aliveLines).toBe(3); // A1, A2 (now in b.txt) + X (new a.txt)
      expect(report.authors).toEqual([
        { author: 'Ada', lines: 2, share: 2 / 3 }, // A1, A2 keep Ada's authorship
        { author: 'Bob', lines: 1, share: 1 / 3 }, // X is Bob's new line
      ]);
    });

    it('does not record deaths when a tracked file grows past the size guard', async () => {
      const mk = (sha: string, authoredAt: string, parents: string[]): CommitInfo => ({
        sha,
        message: sha,
        summary: sha,
        authorName: 'Ada',
        authorEmail: null,
        authoredAt,
        htmlUrl: `https://github.com/acme/rocket/commit/${sha}`,
        parentShas: parents,
      });
      provider.listCommitsResult = () =>
        Promise.resolve([
          mk('c2', '2024-06-01T00:00:00Z', ['c1']),
          mk('c1', '2024-01-01T00:00:00Z', []),
        ]);
      provider.commitFilesResult = () => Promise.resolve([{ path: 'a.txt', status: 'modified' }]);
      // a.txt is text at c1, then exceeds the size guard at c2 (unreadable, not deleted).
      provider.fileAtRefResult = (path, ref) =>
        ref === 'c1'
          ? Promise.resolve({ kind: 'text', path, sha: 'a1', size: 6, text: 'L1\nL2\n' })
          : Promise.resolve({ kind: 'too-large', path, sha: 'a2', size: 9_000_000 });
      await store.loadRepo(slug);

      await store.computeSurvival();

      // No deletion was observed — the client just couldn't load the blob — so the
      // lines are right-censored at that commit: counted (not dropped), but not
      // deaths and not part of the live code.
      const report = store.survival()!.report;
      expect(store.survival()?.status).toBe('ready');
      expect(report.curve.deaths).toBe(0);
      expect(report.trackedLines).toBe(2); // observed, censored — not silently dropped
      expect(report.curve.censored).toBe(2);
      expect(report.aliveLines).toBe(0); // can't confirm them in the current tree
    });

    it('rebuilds content from inline patches without fetching any blobs', async () => {
      const mk = (
        sha: string,
        authorName: string,
        authoredAt: string,
        parents: string[],
      ): CommitInfo => ({
        sha,
        message: sha,
        summary: sha,
        authorName,
        authorEmail: null,
        authoredAt,
        htmlUrl: `https://github.com/acme/rocket/commit/${sha}`,
        parentShas: parents,
      });
      provider.listCommitsResult = () =>
        Promise.resolve([
          mk('c2', 'Bob', '2024-06-01T00:00:00Z', ['c1']),
          mk('c1', 'Ada', '2024-01-01T00:00:00Z', []),
        ]);
      // c1 (Ada) adds a.txt with two lines; c2 (Bob) edits the second — both
      // carry GitHub-style inline patches, so the walk needs no blob fetch.
      provider.commitFilesResult = (sha) =>
        Promise.resolve(
          sha === 'c1'
            ? [
                {
                  path: 'a.txt',
                  status: 'added',
                  additions: 2,
                  deletions: 0,
                  patch: '@@ -0,0 +1,2 @@\n+L1\n+L2',
                },
              ]
            : [
                {
                  path: 'a.txt',
                  status: 'modified',
                  additions: 1,
                  deletions: 1,
                  patch: '@@ -1,2 +1,2 @@\n L1\n-L2\n+L2x',
                },
              ],
        );

      await store.loadRepo(slug);
      await store.computeSurvival();

      const report = store.survival()!.report;
      expect(report.aliveLines).toBe(2); // L1 (Ada) + L2x (Bob)
      expect(report.curve.deaths).toBe(1); // L2 (Ada) was replaced
      expect(report.authors).toEqual([
        { author: 'Ada', lines: 1, share: 0.5 },
        { author: 'Bob', lines: 1, share: 0.5 },
      ]);
      // The whole history was reconstructed from the patches — zero blob fetches.
      expect(provider.fileAtRefCalls).toEqual([]);
    });

    it('falls back to the blob when a patch is truncated (stats do not match)', async () => {
      const mk = (sha: string, authoredAt: string, parents: string[]): CommitInfo => ({
        sha,
        message: sha,
        summary: sha,
        authorName: 'Ada',
        authorEmail: null,
        authoredAt,
        htmlUrl: `https://github.com/acme/rocket/commit/${sha}`,
        parentShas: parents,
      });
      provider.listCommitsResult = () => Promise.resolve([mk('c1', '2024-01-01T00:00:00Z', [])]);
      // The header says 3 additions but the patch only carries 2 — a diff
      // truncated between hunks; the walk must not trust it.
      provider.commitFilesResult = () =>
        Promise.resolve([
          {
            path: 'a.txt',
            status: 'added',
            additions: 3,
            deletions: 0,
            patch: '@@ -0,0 +1,2 @@\n+L1\n+L2',
          },
        ]);
      provider.fileAtRefResult = (path) =>
        Promise.resolve({ kind: 'text', path, sha: 'a1', size: 9, text: 'L1\nL2\nL3\n' });

      await store.loadRepo(slug);
      await store.computeSurvival();

      const report = store.survival()!.report;
      // It fetched the real blob and got all three lines, not the truncated two.
      expect(provider.fileAtRefCalls).toEqual([{ path: 'a.txt', ref: 'c1' }]);
      expect(report.aliveLines).toBe(3);
    });

    it('detects a rename by matching content when the provider gives no previousPath', async () => {
      const mk = (
        sha: string,
        authorName: string,
        authoredAt: string,
        parents: string[],
      ): CommitInfo => ({
        sha,
        message: sha,
        summary: sha,
        authorName,
        authorEmail: null,
        authoredAt,
        htmlUrl: `https://github.com/acme/rocket/commit/${sha}`,
        parentShas: parents,
      });
      provider.listCommitsResult = () =>
        Promise.resolve([
          mk('c2', 'Bob', '2024-06-01T00:00:00Z', ['c1']),
          mk('c1', 'Ada', '2024-01-01T00:00:00Z', []),
        ]);
      // c1 (Ada) adds a.txt; c2 (Bob) `git mv` a.txt → b.txt, reported (as the
      // local reader does) as a plain remove + add with no previousPath.
      provider.commitFilesResult = (sha) =>
        Promise.resolve(
          sha === 'c1'
            ? [{ path: 'a.txt', status: 'added' }]
            : [
                { path: 'a.txt', status: 'removed' },
                { path: 'b.txt', status: 'added' },
              ],
        );
      const blobs: Record<string, string> = { 'a.txt@c1': 'L1\nL2\n', 'b.txt@c2': 'L1\nL2\n' };
      provider.fileAtRefResult = (path, ref) => {
        const text = blobs[`${path}@${ref}`];
        return text === undefined
          ? Promise.reject(new RepoProviderError('absent', 'not-found'))
          : Promise.resolve({ kind: 'text', path, sha: `${path}-${ref}`, size: text.length, text });
      };

      await store.loadRepo(slug);
      await store.computeSurvival();

      const report = store.survival()!.report;
      // The two lines moved to b.txt, keeping Ada's authorship — not killed + reborn under Bob.
      expect(report.curve.deaths).toBe(0);
      expect(report.aliveLines).toBe(2);
      expect(report.authors).toEqual([{ author: 'Ada', lines: 2, share: 1 }]);
    });

    it('detects a rename that also edits the file, by content similarity', async () => {
      const mk = (
        sha: string,
        authorName: string,
        authoredAt: string,
        parents: string[],
      ): CommitInfo => ({
        sha,
        message: sha,
        summary: sha,
        authorName,
        authorEmail: null,
        authoredAt,
        htmlUrl: `https://github.com/acme/rocket/commit/${sha}`,
        parentShas: parents,
      });
      provider.listCommitsResult = () =>
        Promise.resolve([
          mk('c2', 'Bob', '2024-06-01T00:00:00Z', ['c1']),
          mk('c1', 'Ada', '2024-01-01T00:00:00Z', []),
        ]);
      // c1 (Ada) adds a 3-line a.txt; c2 (Bob) moves it to b.txt AND edits one
      // line — reported (no previousPath) as remove + add, ~67% similar.
      provider.commitFilesResult = (sha) =>
        Promise.resolve(
          sha === 'c1'
            ? [{ path: 'a.txt', status: 'added' }]
            : [
                { path: 'a.txt', status: 'removed' },
                { path: 'b.txt', status: 'added' },
              ],
        );
      const blobs: Record<string, string> = {
        'a.txt@c1': 'L1\nL2\nL3\n',
        'b.txt@c2': 'L1\nL2x\nL3\n',
      };
      provider.fileAtRefResult = (path, ref) => {
        const text = blobs[`${path}@${ref}`];
        return text === undefined
          ? Promise.reject(new RepoProviderError('absent', 'not-found'))
          : Promise.resolve({ kind: 'text', path, sha: `${path}-${ref}`, size: text.length, text });
      };

      await store.loadRepo(slug);
      await store.computeSurvival();

      const report = store.survival()!.report;
      // The two unchanged lines keep Ada's authorship; only the edited line dies
      // and is reborn under Bob — not the whole file.
      expect(report.curve.deaths).toBe(1);
      expect(report.aliveLines).toBe(3);
      expect(report.authors).toEqual([
        { author: 'Ada', lines: 2, share: 2 / 3 },
        { author: 'Bob', lines: 1, share: 1 / 3 },
      ]);
    });

    /** A commit factory for the follow-up edge-case tests. */
    const mkCommit = (
      sha: string,
      authorName: string,
      authoredAt: string,
      parents: string[],
    ): CommitInfo => ({
      sha,
      message: sha,
      summary: sha,
      authorName,
      authorEmail: null,
      authoredAt,
      htmlUrl: `https://github.com/acme/rocket/commit/${sha}`,
      parentShas: parents,
    });
    /** Serves text blobs keyed by `path@ref`; a missing key is a not-found. */
    const serveBlobs = (blobs: Record<string, string>): void => {
      provider.fileAtRefResult = (path, ref) => {
        const text = blobs[`${path}@${ref}`];
        return text === undefined
          ? Promise.reject(new RepoProviderError('absent', 'not-found'))
          : Promise.resolve({ kind: 'text', path, sha: `${path}-${ref}`, size: text.length, text });
      };
    };

    it('holds generated/vendored files out of the lifetimes', async () => {
      provider.listCommitsResult = () =>
        Promise.resolve([mkCommit('c1', 'Ada', '2024-01-01T00:00:00Z', [])]);
      // One source file and a lockfile, both added in the same commit.
      provider.commitFilesResult = () =>
        Promise.resolve([
          { path: 'src/app.ts', status: 'added' },
          { path: 'package-lock.json', status: 'added' },
        ]);
      serveBlobs({ 'src/app.ts@c1': 'A1\nA2\n', 'package-lock.json@c1': 'L1\nL2\nL3\nL4\nL5\n' });
      await store.loadRepo(slug);

      await store.computeSurvival();

      const report = store.survival()!.report;
      // Only the two source lines count; the five lockfile lines are excluded.
      expect(report.trackedLines).toBe(2);
      expect(report.aliveLines).toBe(2);
      expect(provider.fileAtRefCalls.map((c) => c.path)).not.toContain('package-lock.json');
    });

    it('records a pure copy as new lines, not an empty file', async () => {
      provider.listCommitsResult = () =>
        Promise.resolve([
          mkCommit('c2', 'Bob', '2024-06-01T00:00:00Z', ['c1']),
          mkCommit('c1', 'Ada', '2024-01-01T00:00:00Z', []),
        ]);
      // c1 (Ada) adds a.txt; c2 (Bob) copies it to b.txt with no content change.
      provider.commitFilesResult = (sha) =>
        Promise.resolve(
          sha === 'c1'
            ? [{ path: 'a.txt', status: 'added' }]
            : [
                {
                  path: 'b.txt',
                  status: 'copied',
                  previousPath: 'a.txt',
                  additions: 0,
                  deletions: 0,
                },
              ],
        );
      serveBlobs({ 'a.txt@c1': 'L1\nL2\n', 'b.txt@c2': 'L1\nL2\n' });
      await store.loadRepo(slug);

      await store.computeSurvival();

      const report = store.survival()!.report;
      // a.txt (Ada) stays; the copy's lines are new births under Bob — not empty.
      expect(report.curve.deaths).toBe(0);
      expect(report.aliveLines).toBe(4);
      expect(report.authors).toEqual([
        { author: 'Ada', lines: 2, share: 0.5 },
        { author: 'Bob', lines: 2, share: 0.5 },
      ]);
    });

    it('preserves every rename when identical files are mass-moved', async () => {
      provider.listCommitsResult = () =>
        Promise.resolve([
          mkCommit('c2', 'Bob', '2024-06-01T00:00:00Z', ['c1']),
          mkCommit('c1', 'Ada', '2024-01-01T00:00:00Z', []),
        ]);
      // c1 (Ada) adds two identical files; c2 moves both (remove + add, no previousPath).
      provider.commitFilesResult = (sha) =>
        Promise.resolve(
          sha === 'c1'
            ? [
                { path: 'a.txt', status: 'added' },
                { path: 'b.txt', status: 'added' },
              ]
            : [
                { path: 'a.txt', status: 'removed' },
                { path: 'b.txt', status: 'removed' },
                { path: 'x.txt', status: 'added' },
                { path: 'y.txt', status: 'added' },
              ],
        );
      serveBlobs({
        'a.txt@c1': 'L1\nL2\n',
        'b.txt@c1': 'L1\nL2\n',
        'x.txt@c2': 'L1\nL2\n',
        'y.txt@c2': 'L1\nL2\n',
      });
      await store.loadRepo(slug);

      await store.computeSurvival();

      const report = store.survival()!.report;
      // Both identical moves are recognised — nothing dies, all four lines stay Ada's.
      expect(report.curve.deaths).toBe(0);
      expect(report.aliveLines).toBe(4);
      expect(report.authors).toEqual([{ author: 'Ada', lines: 4, share: 1 }]);
    });

    it('carries a rename that overwrites an existing file (git mv -f)', async () => {
      provider.listCommitsResult = () =>
        Promise.resolve([
          mkCommit('c2', 'Bob', '2024-06-01T00:00:00Z', ['c1']),
          mkCommit('c1', 'Ada', '2024-01-01T00:00:00Z', []),
        ]);
      // c1 (Ada) adds old.txt and existing.txt; c2 (Bob) `git mv -f old.txt
      // existing.txt` → old.txt removed, existing.txt modified to old's content.
      provider.commitFilesResult = (sha) =>
        Promise.resolve(
          sha === 'c1'
            ? [
                { path: 'old.txt', status: 'added' },
                { path: 'existing.txt', status: 'added' },
              ]
            : [
                { path: 'old.txt', status: 'removed' },
                { path: 'existing.txt', status: 'modified' },
              ],
        );
      serveBlobs({
        'old.txt@c1': 'L1\nL2\n',
        'existing.txt@c1': 'X1\nX2\n',
        'existing.txt@c2': 'L1\nL2\n', // overwritten with old.txt's content
      });
      await store.loadRepo(slug);

      await store.computeSurvival();

      const report = store.survival()!.report;
      // old.txt's lines carry into existing.txt (still Ada); existing.txt's own
      // two original lines are retired as overwritten.
      expect(report.curve.deaths).toBe(2);
      expect(report.aliveLines).toBe(2);
      expect(report.authors).toEqual([{ author: 'Ada', lines: 2, share: 1 }]);
    });
  });
});
