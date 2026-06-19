import { TestBed } from '@angular/core/testing';
import git from 'isomorphic-git';

import { RepoSlug } from '../../models';
import { FsLike } from './fsa-fs';
import { createMemFs } from './mem-fs';
import { LocalGitProvider } from './local-provider';
import { LocalRepos } from './local-repos';

const slug: RepoSlug = { provider: 'local', owner: 'local', repo: 'demo' };

const author = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: 0,
};

describe('LocalGitProvider', () => {
  let provider: LocalGitProvider;
  let fs: FsLike;
  let c1 = '';
  let c2 = '';
  let c3 = '';

  beforeEach(async () => {
    fs = createMemFs();
    await git.init({ fs, dir: '/', defaultBranch: 'main' });

    await fs.promises.writeFile('/hello.txt', 'one\n');
    await git.add({ fs, dir: '/', filepath: 'hello.txt' });
    c1 = await git.commit({ fs, dir: '/', message: 'c1: add hello', author });

    await fs.promises.writeFile('/hello.txt', 'one\ntwo\n');
    await git.add({ fs, dir: '/', filepath: 'hello.txt' });
    c2 = await git.commit({ fs, dir: '/', message: 'c2: extend hello', author });

    await fs.promises.writeFile('/greeting.txt', 'one\ntwo\n');
    await fs.promises.unlink('/hello.txt');
    await git.remove({ fs, dir: '/', filepath: 'hello.txt' });
    await git.add({ fs, dir: '/', filepath: 'greeting.txt' });
    c3 = await git.commit({ fs, dir: '/', message: 'c3: rename hello to greeting', author });

    TestBed.inject(LocalRepos).register('demo', fs);
    provider = TestBed.inject(LocalGitProvider);
  });

  it('reads metadata from HEAD', async () => {
    const metadata = await provider.getMetadata(slug);
    expect(metadata).toMatchObject({ name: 'demo', defaultBranch: 'main' });
    expect(provider.webLinks()).toBeNull();
  });

  it('walks the tree of a ref', async () => {
    const tree = await provider.getTree(slug, 'main');
    expect(tree.truncated).toBe(false);
    expect(tree.entries).toHaveLength(1);
    expect(tree.entries[0]).toMatchObject({ path: 'greeting.txt', kind: 'file' });
    // Size is read from the working tree ('one\ntwo\n' is 8 bytes).
    expect(tree.entries[0].size).toBe(8);
  });

  it('reads blobs by tree entry and historical versions by ref', async () => {
    const tree = await provider.getTree(slug, 'main');
    const file = await provider.getFile(slug, tree.entries[0]);
    expect(file).toMatchObject({ kind: 'text', text: 'one\ntwo\n' });

    const v1 = await provider.getFileAtRef(slug, 'hello.txt', c1);
    expect(v1).toMatchObject({ kind: 'text', text: 'one\n' });
    const v2 = await provider.getFileAtRef(slug, 'hello.txt', c2);
    expect(v2).toMatchObject({ kind: 'text', text: 'one\ntwo\n' });
  });

  it('maps a missing path at a ref to not-found (blame relies on this)', async () => {
    await expect(provider.getFileAtRef(slug, 'hello.txt', c3)).rejects.toMatchObject({
      kind: 'not-found',
    });
  });

  it('lists commits filtered by path, newest first', async () => {
    const commits = await provider.listCommits(slug, { ref: 'main', path: 'hello.txt' });
    expect(commits.map((c) => c.summary)).toEqual([
      'c3: rename hello to greeting',
      'c2: extend hello',
      'c1: add hello',
    ]);
    expect(commits.map((c) => c.sha)).toEqual([c3, c2, c1]);
  });

  it('walks a path history once and serves later pages from cache', async () => {
    const logSpy = vi.spyOn(git, 'log');
    const page1 = await provider.listCommits(slug, {
      ref: 'main',
      path: 'hello.txt',
      perPage: 2,
      page: 1,
    });
    const page2 = await provider.listCommits(slug, {
      ref: 'main',
      path: 'hello.txt',
      perPage: 2,
      page: 2,
    });

    expect(page1.map((c) => c.sha)).toEqual([c3, c2]);
    expect(page2.map((c) => c.sha)).toEqual([c1]);
    // The full path-filtered walk happens once; the second page is a cache slice
    // rather than another whole-history walk (the old quadratic "Load all").
    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it('paginates unfiltered history and reuses the grown cache', async () => {
    const logSpy = vi.spyOn(git, 'log');
    const page1 = await provider.listCommits(slug, { ref: 'main', perPage: 2, page: 1 });
    const page2 = await provider.listCommits(slug, { ref: 'main', perPage: 2, page: 2 });
    expect(page1.map((c) => c.sha)).toEqual([c3, c2]);
    expect(page2.map((c) => c.sha)).toEqual([c1]);

    // A page already covered by the cache is served without another walk.
    const calls = logSpy.mock.calls.length;
    const again = await provider.listCommits(slug, { ref: 'main', perPage: 2, page: 1 });
    expect(again.map((c) => c.sha)).toEqual([c3, c2]);
    expect(logSpy.mock.calls.length).toBe(calls);
    logSpy.mockRestore();
  });

  it('primeHistories precomputes every path history in one pass (nested dirs)', async () => {
    // Add a nested file across two commits to exercise subtree-diff recursion.
    await fs.promises.writeFile('/src/lib/util.ts', 'export const a = 1;\n');
    await git.add({ fs, dir: '/', filepath: 'src/lib/util.ts' });
    const c4 = await git.commit({ fs, dir: '/', message: 'c4: add nested util', author });
    await fs.promises.writeFile('/src/lib/util.ts', 'export const a = 2;\n');
    await git.add({ fs, dir: '/', filepath: 'src/lib/util.ts' });
    const c5 = await git.commit({ fs, dir: '/', message: 'c5: edit nested util', author });

    await provider.primeHistories(slug, 'main');

    // After priming, every path is served from cache — no per-file log walks.
    const logSpy = vi.spyOn(git, 'log');
    const nested = await provider.listCommits(slug, { ref: 'main', path: 'src/lib/util.ts' });
    const hello = await provider.listCommits(slug, { ref: 'main', path: 'hello.txt' });
    const greeting = await provider.listCommits(slug, { ref: 'main', path: 'greeting.txt' });
    const missing = await provider.listCommits(slug, { ref: 'main', path: 'does/not/exist.ts' });

    expect(nested.map((c) => c.sha)).toEqual([c5, c4]);
    expect(hello.map((c) => c.sha)).toEqual([c3, c2, c1]);
    expect(greeting.map((c) => c.sha)).toEqual([c3]);
    expect(missing).toEqual([]);
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('primeHistories matches per-file git.log and is idempotent', async () => {
    const direct = await provider.listCommits(slug, { ref: 'main', path: 'hello.txt' });

    await provider.primeHistories(slug, 'main');
    const firstPass = vi.spyOn(git, 'log');
    await provider.primeHistories(slug, 'main'); // cached — must not walk again
    expect(firstPass).not.toHaveBeenCalled();
    firstPass.mockRestore();

    const primed = await provider.listCommits(slug, { ref: 'main', path: 'hello.txt' });
    expect(primed.map((c) => c.sha)).toEqual(direct.map((c) => c.sha));
  });

  it('resolves single commits with parents and ISO dates', async () => {
    const commit = await provider.getCommit(slug, c2);
    expect(commit.parentShas).toEqual([c1]);
    expect(commit.authorName).toBe('Ada');
    expect(commit.authoredAt).toBe(new Date(author.timestamp * 1000).toISOString());
  });

  it('diffs commit trees for touched files (rename = remove + add)', async () => {
    const changes = await provider.getCommitFiles(slug, c3);
    expect(changes).toEqual(
      expect.arrayContaining([
        { path: 'hello.txt', status: 'removed' },
        { path: 'greeting.txt', status: 'added' },
      ]),
    );

    const initial = await provider.getCommitFiles(slug, c1);
    expect(initial).toEqual([{ path: 'hello.txt', status: 'added' }]);
  });

  it('reports modified files and recurses into nested subtrees', async () => {
    // Root-level edit (c2 changed hello.txt's content).
    expect(await provider.getCommitFiles(slug, c2)).toEqual([
      { path: 'hello.txt', status: 'modified' },
    ]);

    // A change deep in a subtree is found by the oid-pruned recursion, with the
    // unrelated root files skipped.
    await fs.promises.writeFile('/src/lib/util.ts', 'export const a = 1;\n');
    await git.add({ fs, dir: '/', filepath: 'src/lib/util.ts' });
    const c4 = await git.commit({ fs, dir: '/', message: 'c4: add nested', author });
    expect(await provider.getCommitFiles(slug, c4)).toEqual([
      { path: 'src/lib/util.ts', status: 'added' },
    ]);

    await fs.promises.writeFile('/src/lib/util.ts', 'export const a = 2;\n');
    await git.add({ fs, dir: '/', filepath: 'src/lib/util.ts' });
    const c5 = await git.commit({ fs, dir: '/', message: 'c5: edit nested', author });
    expect(await provider.getCommitFiles(slug, c5)).toEqual([
      { path: 'src/lib/util.ts', status: 'modified' },
    ]);
  });

  it('skips gitlink (submodule) entries, reporting only tracked files', async () => {
    // A gitlink can't be staged through the high-level API, so write the tree
    // objects directly: one tracked file changes, and a submodule is added.
    const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
    const v1 = await git.writeBlob({ fs, dir: '/', blob: enc('one\n') });
    const v2 = await git.writeBlob({ fs, dir: '/', blob: enc('two\n') });
    const parentTree = await git.writeTree({
      fs,
      dir: '/',
      tree: [{ mode: '100644', path: 'keep.txt', oid: v1, type: 'blob' }],
    });
    const parent = await git.writeCommit({
      fs,
      dir: '/',
      commit: { message: 'p', tree: parentTree, parent: [], author, committer: author },
    });
    const childTree = await git.writeTree({
      fs,
      dir: '/',
      tree: [
        { mode: '100644', path: 'keep.txt', oid: v2, type: 'blob' },
        { mode: '160000', path: 'submodule', oid: parent, type: 'commit' }, // a gitlink
      ],
    });
    const child = await git.writeCommit({
      fs,
      dir: '/',
      commit: { message: 'c', tree: childTree, parent: [parent], author, committer: author },
    });

    // keep.txt is reported; the added gitlink is skipped (no blob to read), so
    // downstream walks never try to fetch it.
    expect(await provider.getCommitFiles(slug, child)).toEqual([
      { path: 'keep.txt', status: 'modified' },
    ]);
  });

  it('records the removal when a tracked path becomes a submodule', async () => {
    const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
    const blob = await git.writeBlob({ fs, dir: '/', blob: enc('hi\n') });
    const parentTree = await git.writeTree({
      fs,
      dir: '/',
      tree: [{ mode: '100644', path: 'mod.ts', oid: blob, type: 'blob' }],
    });
    const parent = await git.writeCommit({
      fs,
      dir: '/',
      commit: { message: 'p', tree: parentTree, parent: [], author, committer: author },
    });
    // The same path is now a gitlink — the file was replaced by a submodule.
    const childTree = await git.writeTree({
      fs,
      dir: '/',
      tree: [{ mode: '160000', path: 'mod.ts', oid: parent, type: 'commit' }],
    });
    const child = await git.writeCommit({
      fs,
      dir: '/',
      commit: { message: 'c', tree: childTree, parent: [parent], author, committer: author },
    });

    // The blob is gone; the gitlink that replaced it is skipped, but the removal
    // must still be reported so downstream walks don't keep the file alive.
    expect(await provider.getCommitFiles(slug, child)).toEqual([
      { path: 'mod.ts', status: 'removed' },
    ]);
  });

  it('fails with guidance when the folder is not connected', async () => {
    await expect(
      provider.getMetadata({ provider: 'local', owner: 'local', repo: 'ghost' }),
    ).rejects.toMatchObject({ kind: 'not-found' });
  });
});
