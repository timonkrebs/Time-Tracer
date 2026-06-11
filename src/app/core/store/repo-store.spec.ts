import { TestBed } from '@angular/core/testing';

import { GIT_PROVIDERS, GitProvider, RepoWebLinks } from '../git/git-provider';
import {
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
  treeRefs: string[] = [];

  metadataResult: () => Promise<RepoMetadata> = () => Promise.resolve(metadata);
  treeResult: () => Promise<RepoTree> = () => Promise.resolve({ entries, truncated: false });
  fileResult: (entry: TreeEntry) => Promise<RepoFile> = (entry) =>
    Promise.resolve({
      kind: 'text',
      path: entry.path,
      sha: entry.sha,
      size: entry.size ?? 0,
      text: 'content of ' + entry.path,
    });

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
    return this.treeResult();
  }
  getFile(_slug: RepoSlug, entry: TreeEntry): Promise<RepoFile> {
    this.fileCalls.push(entry.path);
    return this.fileResult(entry);
  }
  listCommits(): Promise<CommitInfo[]> {
    return Promise.resolve([]);
  }
  webLinks(): RepoWebLinks {
    return { repoUrl: 'https://github.com/acme/rocket' };
  }
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
});
