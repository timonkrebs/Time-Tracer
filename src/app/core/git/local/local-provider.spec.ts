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

  it('lists the local branches', async () => {
    await git.branch({ fs, dir: '/', ref: 'feature/foo', checkout: false });

    const list = await provider.listBranches(slug);

    expect(list.truncated).toBe(false);
    expect([...list.names].sort()).toEqual(['feature/foo', 'main']);
  });

  it('lists tags, dereferencing annotated ones to their commit', async () => {
    await git.tag({ fs, dir: '/', ref: 'v-light', object: c1 });
    await git.annotatedTag({
      fs,
      dir: '/',
      ref: 'v-annotated',
      object: c2,
      message: 'release',
      tagger: author,
    });

    const list = await provider.listTags(slug);

    expect(list.truncated).toBe(false);
    const bySha = new Map(list.tags.map((tag) => [tag.name, tag.sha]));
    expect(bySha.get('v-light')).toBe(c1);
    expect(bySha.get('v-annotated')).toBe(c2);
  });

  it('orders tags by their target commit date, not alphabetically', async () => {
    // 'aa-old' would win an alphabetical cut; the newest-tagged commit must.
    await fs.promises.writeFile('/late.txt', 'late\n');
    await git.add({ fs, dir: '/', filepath: 'late.txt' });
    const c4 = await git.commit({
      fs,
      dir: '/',
      message: 'c4: later work',
      author: { ...author, timestamp: author.timestamp + 100 },
    });
    await git.tag({ fs, dir: '/', ref: 'aa-old', object: c1 });
    await git.tag({ fs, dir: '/', ref: 'zz-new', object: c4 });

    const list = await provider.listTags(slug);

    expect(list.tags[0]).toEqual({ name: 'zz-new', sha: c4 });
  });

  it('walks the tree of a ref', async () => {
    const tree = await provider.getTree(slug, 'main');
    expect(tree.truncated).toBe(false);
    expect(tree.entries).toHaveLength(1);
    expect(tree.entries[0]).toMatchObject({ path: 'greeting.txt', kind: 'file' });
    // Size is read from the working tree ('one\ntwo\n' is 8 bytes).
    expect(tree.entries[0].size).toBe(8);
  });

  it('populates a size for every working-tree file, across nested folders', async () => {
    await fs.promises.writeFile('/src/a.ts', 'aaaa'); // 4 bytes
    await git.add({ fs, dir: '/', filepath: 'src/a.ts' });
    await fs.promises.writeFile('/src/deep/b.ts', 'bbbbbbbb'); // 8 bytes
    await git.add({ fs, dir: '/', filepath: 'src/deep/b.ts' });
    await git.commit({ fs, dir: '/', message: 'c4: add sources', author });

    const tree = await provider.getTree(slug, 'main');
    const byPath = new Map(tree.entries.map((entry) => [entry.path, entry]));

    expect(byPath.get('src/a.ts')?.size).toBe(4);
    expect(byPath.get('src/deep/b.ts')?.size).toBe(8);

    // The regression guard: every file entry carries a numeric size, so the
    // treemap can scale by it and the size filter has a spread to work with.
    const files = tree.entries.filter((entry) => entry.kind === 'file');
    expect(files.length).toBeGreaterThan(1);
    expect(files.every((entry) => typeof entry.size === 'number')).toBe(true);
    expect(new Set(files.map((entry) => entry.size)).size).toBeGreaterThan(1);

    // Directories never carry a size.
    expect(byPath.get('src')).toMatchObject({ kind: 'dir' });
    expect(byPath.get('src')?.size).toBeUndefined();
  });

  it('leaves size undefined for a tree file missing from the working tree', async () => {
    await fs.promises.writeFile('/tracked.txt', 'hello'); // 5 bytes
    await git.add({ fs, dir: '/', filepath: 'tracked.txt' });
    await git.commit({ fs, dir: '/', message: 'c4: add tracked', author });
    // Remove it from the working tree only — it stays in the committed tree.
    await fs.promises.unlink('/tracked.txt');

    const tree = await provider.getTree(slug, 'main');
    const byPath = new Map(tree.entries.map((entry) => [entry.path, entry]));

    expect(byPath.has('tracked.txt')).toBe(true); // still in the tree…
    expect(byPath.get('tracked.txt')?.size).toBeUndefined(); // …but no working file
    expect(byPath.get('greeting.txt')?.size).toBe(8); // other files stay sized
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

  it('serves a path history through the one-pass prime walk (no filepath log)', async () => {
    const logSpy = vi.spyOn(git, 'log');
    await provider.listCommits(slug, { ref: 'main', path: 'hello.txt' });
    // One full-history walk with no per-commit path resolution…
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).not.toHaveProperty('filepath');
    // …that also primes every other path and the unfiltered log.
    const greeting = await provider.listCommits(slug, { ref: 'main', path: 'greeting.txt' });
    const all = await provider.listCommits(slug, { ref: 'main', perPage: 2, page: 2 });
    expect(greeting.map((c) => c.sha)).toEqual([c3]);
    expect(all.map((c) => c.sha)).toEqual([c1]);
    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it('shares one prime walk across concurrent path-history requests', async () => {
    const logSpy = vi.spyOn(git, 'log');
    const [hello, greeting] = await Promise.all([
      provider.listCommits(slug, { ref: 'main', path: 'hello.txt' }),
      provider.listCommits(slug, { ref: 'main', path: 'greeting.txt' }),
    ]);
    expect(hello.map((c) => c.sha)).toEqual([c3, c2, c1]);
    expect(greeting.map((c) => c.sha)).toEqual([c3]);
    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it('extends an unfiltered walk by at least doubling (paging stays linear)', async () => {
    const logSpy = vi.spyOn(git, 'log');
    await provider.listCommits(slug, { ref: 'main', perPage: 1, page: 1 });
    await provider.listCommits(slug, { ref: 'main', perPage: 1, page: 2 });
    await provider.listCommits(slug, { ref: 'main', perPage: 1, page: 3 });
    const depths = logSpy.mock.calls.map(([options]) => (options as { depth?: number }).depth);
    expect(depths).toEqual([1, 2, 4]);
    // The third walk overshot the 3-commit history, so the log is complete now.
    await provider.listCommits(slug, { ref: 'main', perPage: 1, page: 1 });
    expect(logSpy).toHaveBeenCalledTimes(3);
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

  it('omits merges from a path history unless the path differs from every parent', async () => {
    // Build a real merge by writing objects directly:
    //   A (file v1) ── B (adds other.txt) ──┐
    //   └────────────  C (file v2)  ────────┴─ M (parents [B, C])
    // M takes file.txt from C and other.txt from B, and adds merged.txt itself.
    const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
    const v1 = await git.writeBlob({ fs, dir: '/', blob: enc('one\n') });
    const v2 = await git.writeBlob({ fs, dir: '/', blob: enc('two\n') });
    const other = await git.writeBlob({ fs, dir: '/', blob: enc('other\n') });
    const merged = await git.writeBlob({ fs, dir: '/', blob: enc('merged\n') });
    const at = (offset: number): typeof author => ({
      ...author,
      timestamp: author.timestamp + offset,
    });
    const treeA = await git.writeTree({
      fs,
      dir: '/',
      tree: [{ mode: '100644', path: 'file.txt', oid: v1, type: 'blob' }],
    });
    const commitA = await git.writeCommit({
      fs,
      dir: '/',
      commit: { message: 'A', tree: treeA, parent: [], author: at(0), committer: at(0) },
    });
    const treeB = await git.writeTree({
      fs,
      dir: '/',
      tree: [
        { mode: '100644', path: 'file.txt', oid: v1, type: 'blob' },
        { mode: '100644', path: 'other.txt', oid: other, type: 'blob' },
      ],
    });
    const commitB = await git.writeCommit({
      fs,
      dir: '/',
      commit: { message: 'B', tree: treeB, parent: [commitA], author: at(60), committer: at(60) },
    });
    const treeC = await git.writeTree({
      fs,
      dir: '/',
      tree: [{ mode: '100644', path: 'file.txt', oid: v2, type: 'blob' }],
    });
    const commitC = await git.writeCommit({
      fs,
      dir: '/',
      commit: { message: 'C', tree: treeC, parent: [commitA], author: at(120), committer: at(120) },
    });
    const treeM = await git.writeTree({
      fs,
      dir: '/',
      tree: [
        { mode: '100644', path: 'file.txt', oid: v2, type: 'blob' },
        { mode: '100644', path: 'other.txt', oid: other, type: 'blob' },
        { mode: '100644', path: 'merged.txt', oid: merged, type: 'blob' },
      ],
    });
    const commitM = await git.writeCommit({
      fs,
      dir: '/',
      commit: {
        message: 'M',
        tree: treeM,
        parent: [commitB, commitC],
        author: at(180),
        committer: at(180),
      },
    });
    await git.writeRef({ fs, dir: '/', ref: 'refs/heads/merged', value: commitM });

    // file.txt changed on the side branch; the merge is identical to C — like
    // `git log -- file.txt`, the merge commit is not part of the history.
    const file = await provider.listCommits(slug, { ref: 'merged', path: 'file.txt' });
    expect(file.map((c) => c.sha)).toEqual([commitC, commitA]);
    // other.txt came through the merge unchanged from B.
    const otherHistory = await provider.listCommits(slug, { ref: 'merged', path: 'other.txt' });
    expect(otherHistory.map((c) => c.sha)).toEqual([commitB]);
    // merged.txt differs from BOTH parents — the merge itself introduced it.
    const mergedHistory = await provider.listCommits(slug, { ref: 'merged', path: 'merged.txt' });
    expect(mergedHistory.map((c) => c.sha)).toEqual([commitM]);
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
