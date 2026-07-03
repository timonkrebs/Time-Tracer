import { TestBed } from '@angular/core/testing';

import { RepoSlug, TreeEntry } from '../../models';
import { AccessTokens } from '../access-tokens';
import { BitbucketCloudProvider } from './bitbucket-cloud-provider';

const slug: RepoSlug = { provider: 'bitbucket', owner: 'acme', repo: 'rocket' };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('BitbucketCloudProvider', () => {
  let provider: BitbucketCloudProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    provider = TestBed.inject(BitbucketCloudProvider);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps repository metadata', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        slug: 'rocket',
        name: 'Rocket',
        full_name: 'acme/rocket',
        description: 'a rocket',
        mainbranch: { name: 'develop' },
        links: { html: { href: 'https://bitbucket.org/acme/rocket' } },
      }),
    );

    const metadata = await provider.getMetadata(slug);

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.bitbucket.org/2.0/repositories/acme/rocket');
    expect(metadata).toMatchObject({ fullName: 'acme/rocket', defaultBranch: 'develop' });
  });

  it('lists branch names following the paged next links', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          values: [{ name: 'develop' }, { name: 'main' }],
          next: 'https://api.bitbucket.org/2.0/repositories/acme/rocket/refs/branches?page=2',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ values: [{ name: 'release/1.0' }] }));

    const list = await provider.listBranches(slug);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.bitbucket.org/2.0/repositories/acme/rocket/refs/branches?pagelen=100&sort=name',
    );
    expect(list).toEqual({ names: ['develop', 'main', 'release/1.0'], truncated: false });
  });

  it('lists the tree and carries the resolved commit as the entry sha', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        values: [
          { path: 'README.md', type: 'commit_file', size: 12, commit: { hash: 'deadbeef' } },
          { path: 'src', type: 'commit_directory', commit: { hash: 'deadbeef' } },
        ],
      }),
    );

    const tree = await provider.getTree(slug, 'main');

    expect(fetchMock.mock.calls[0][0]).toContain('/src/main/?max_depth=');
    expect(tree.entries).toEqual([
      { path: 'README.md', name: 'README.md', kind: 'file', sha: 'deadbeef', size: 12 },
      { path: 'src', name: 'src', kind: 'dir', sha: 'deadbeef' },
    ]);
  });

  it('follows the next link when paging the tree', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          values: [{ path: 'a.ts', type: 'commit_file', commit: { hash: 'c1' } }],
          next: 'https://api.bitbucket.org/2.0/repositories/acme/rocket/src/c1/?page=2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ values: [{ path: 'b.ts', type: 'commit_file', commit: { hash: 'c1' } }] }),
      );

    const tree = await provider.getTree(slug, 'main');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tree.entries.map((e) => e.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('fetches file content as raw bytes addressed by commit', async () => {
    fetchMock.mockResolvedValue(new Response('hello world\n', { status: 200 }));
    const entry: TreeEntry = { path: 'a.txt', name: 'a.txt', kind: 'file', sha: 'c1', size: 12 };

    const file = await provider.getFile(slug, entry);

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.bitbucket.org/2.0/repositories/acme/rocket/src/c1/a.txt');
    expect(file).toMatchObject({ kind: 'text', text: 'hello world\n', sha: 'c1' });
  });

  it('uses the filehistory endpoint when a path is given', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        values: [
          {
            commit: {
              hash: 'c1',
              message: 'feat: x\n\nbody',
              date: '2026-01-01T00:00:00Z',
              author: { raw: 'Ada <ada@example.com>' },
              parents: [{ hash: 'p1' }],
              links: { html: { href: 'https://bitbucket.org/acme/rocket/commits/c1' } },
            },
            path: 'README.md',
          },
        ],
      }),
    );

    const commits = await provider.listCommits(slug, { ref: 'main', path: 'README.md' });

    expect(fetchMock.mock.calls[0][0]).toContain('/filehistory/main/README.md');
    expect(commits[0]).toMatchObject({
      sha: 'c1',
      summary: 'feat: x',
      authorName: 'Ada',
      authorEmail: 'ada@example.com',
      parentShas: ['p1'],
    });
  });

  it('maps a commit diffstat including renames', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        values: [
          { status: 'renamed', old: { path: 'old.ts' }, new: { path: 'new.ts' } },
          { status: 'modified', old: { path: 'README.md' }, new: { path: 'README.md' } },
          { status: 'removed', old: { path: 'gone.ts' }, new: null },
        ],
      }),
    );

    const files = await provider.getCommitFiles(slug, 'c1');

    expect(files).toEqual([
      { path: 'new.ts', status: 'renamed', previousPath: 'old.ts' },
      { path: 'README.md', status: 'modified' },
      { path: 'gone.ts', status: 'removed' },
    ]);
  });

  it('builds Bitbucket web links', () => {
    const links = provider.webLinks(slug, 'main', 'src/app.ts');
    expect(links.fileUrl).toBe('https://bitbucket.org/acme/rocket/src/main/src/app.ts');
    expect(links.rawFileUrl).toBe('https://bitbucket.org/acme/rocket/raw/main/src/app.ts');
  });

  it('recognises Bitbucket inputs via canHandle', () => {
    expect(provider.canHandle('https://bitbucket.org/a/b')).toBe(true);
    expect(provider.canHandle('https://github.com/a/b')).toBe(false);
  });

  it('sends a bare token as Bearer and a user:pair as Basic', async () => {
    const tokens = TestBed.inject(AccessTokens);
    // A fresh Response per call — a body can only be read once.
    fetchMock.mockImplementation(() =>
      jsonResponse({ slug: 'rocket', name: 'r', full_name: 'acme/rocket' }),
    );

    tokens.setToken('bitbucket', 'repo_token');
    await provider.getMetadata(slug);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: 'Bearer repo_token' },
    });

    tokens.setToken('bitbucket', 'ada:app_pw');
    await provider.getMetadata(slug);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      headers: { Authorization: `Basic ${btoa('ada:app_pw')}` },
    });
  });

  it('maps 404s to not-found', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ type: 'error' }, { status: 404 }));
    await expect(provider.getMetadata(slug)).rejects.toMatchObject({ kind: 'not-found' });
  });
});
