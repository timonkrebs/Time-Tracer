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

  it('fails with guidance when the folder is not connected', async () => {
    await expect(
      provider.getMetadata({ provider: 'local', owner: 'local', repo: 'ghost' }),
    ).rejects.toMatchObject({ kind: 'not-found' });
  });
});
