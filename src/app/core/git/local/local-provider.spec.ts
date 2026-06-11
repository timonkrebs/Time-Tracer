import { TestBed } from '@angular/core/testing';
import git from 'isomorphic-git';

import { RepoSlug } from '../../models';
import { FsLike, fsError, makeStats } from './fsa-fs';
import { LocalGitProvider } from './local-provider';
import { LocalRepos } from './local-repos';

const slug: RepoSlug = { provider: 'local', owner: 'local', repo: 'demo' };

const author = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: 0,
};

/** Minimal in-memory fs (read + write) so isomorphic-git can build a repo. */
function createMemFs(): FsLike {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(['']);
  const norm = (p: string): string =>
    p
      .split('/')
      .filter((s) => s.length > 0 && s !== '.')
      .join('/');
  const parentOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')));
  const addParents = (p: string): void => {
    let dir = parentOf(p);
    while (dir && !dirs.has(dir)) {
      dirs.add(dir);
      dir = parentOf(dir);
    }
  };

  return {
    promises: {
      async readFile(path: string, options?: unknown) {
        const key = norm(path);
        const bytes = files.get(key);
        if (!bytes) throw fsError('ENOENT', key);
        const encoding =
          typeof options === 'string'
            ? options
            : ((options as { encoding?: string } | undefined)?.encoding ?? null);
        return encoding === 'utf8' ? new TextDecoder().decode(bytes) : bytes;
      },
      async writeFile(path: string, data: unknown) {
        const key = norm(path);
        addParents(key);
        files.set(
          key,
          typeof data === 'string'
            ? new TextEncoder().encode(data)
            : new Uint8Array(data as ArrayBuffer & Uint8Array),
        );
      },
      async readdir(path: string) {
        const key = norm(path);
        if (!dirs.has(key)) throw fsError('ENOENT', key);
        const names = new Set<string>();
        const prefix = key ? `${key}/` : '';
        for (const file of files.keys()) {
          if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split('/')[0]);
        }
        for (const dir of dirs) {
          if (dir && dir.startsWith(prefix) && dir !== key) {
            names.add(dir.slice(prefix.length).split('/')[0]);
          }
        }
        return [...names];
      },
      async stat(path: string) {
        const key = norm(path);
        const bytes = files.get(key);
        if (bytes) return makeStats('file', bytes.length, 0);
        if (dirs.has(key)) return makeStats('dir', 0, 0);
        throw fsError('ENOENT', key);
      },
      async lstat(path: string) {
        return this.stat(path);
      },
      async readlink(path: string): Promise<string> {
        throw fsError('ENOENT', path);
      },
      async mkdir(path: string) {
        const key = norm(path);
        if (dirs.has(key) || files.has(key)) throw fsError('EEXIST', key);
        addParents(key);
        dirs.add(key);
      },
      async rmdir(path: string) {
        dirs.delete(norm(path));
      },
      async unlink(path: string) {
        const key = norm(path);
        if (!files.delete(key)) throw fsError('ENOENT', key);
      },
      async rename(oldPath: string, newPath: string) {
        const from = norm(oldPath);
        const to = norm(newPath);
        const bytes = files.get(from);
        if (!bytes) throw fsError('ENOENT', from);
        files.delete(from);
        addParents(to);
        files.set(to, bytes);
      },
      async symlink(_target: string, path: string) {
        throw fsError('EROFS', path);
      },
    },
  };
}

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
