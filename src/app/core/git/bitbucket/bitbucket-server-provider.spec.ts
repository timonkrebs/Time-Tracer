import { TestBed } from '@angular/core/testing';

import { RepoSlug, TreeEntry } from '../../models';
import { AccessTokens } from '../access-tokens';
import { BitbucketServerProvider } from './bitbucket-server-provider';

const slug: RepoSlug = {
  provider: 'bitbucket-server',
  owner: 'ENG',
  repo: 'rocket',
  host: 'https://bitbucket.example.com',
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('BitbucketServerProvider', () => {
  let provider: BitbucketServerProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    provider = TestBed.inject(BitbucketServerProvider);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is never auto-detected (self-hosted only)', () => {
    expect(provider.canHandle()).toBe(false);
    expect(provider.parseUrl()).toBeNull();
  });

  it('maps metadata with the default branch', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          slug: 'rocket',
          name: 'rocket',
          project: { key: 'ENG', name: 'Engineering' },
          links: { self: [{ href: 'https://bitbucket.example.com/projects/ENG/repos/rocket' }] },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ displayId: 'main' }));

    const metadata = await provider.getMetadata(slug);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://bitbucket.example.com/rest/api/1.0/projects/ENG/repos/rocket',
    );
    expect(metadata).toMatchObject({ fullName: 'ENG/rocket', defaultBranch: 'main' });
  });

  it('resolves the tree commit then lists flat file paths', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ values: [{ id: 'c1' }] })) // firstCommitId
      .mockResolvedValueOnce(jsonResponse({ values: ['README.md', 'src/app.ts'], isLastPage: true }));

    const tree = await provider.getTree(slug, 'main');

    expect(fetchMock.mock.calls[0][0]).toContain('/commits?until=main&limit=1');
    expect(fetchMock.mock.calls[1][0]).toContain('/files?at=main&limit=1000&start=0');
    expect(tree.entries).toEqual([
      { path: 'README.md', name: 'README.md', kind: 'file', sha: 'c1' },
      { path: 'src/app.ts', name: 'app.ts', kind: 'file', sha: 'c1' },
    ]);
  });

  it('fetches raw content addressed by commit', async () => {
    fetchMock.mockResolvedValue(new Response('content\n', { status: 200 }));
    const entry: TreeEntry = { path: 'a.txt', name: 'a.txt', kind: 'file', sha: 'c1' };

    const file = await provider.getFile(slug, entry);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://bitbucket.example.com/projects/ENG/repos/rocket/raw/a.txt?at=c1',
    );
    expect(file).toMatchObject({ kind: 'text', text: 'content\n', sha: 'c1' });
  });

  it('lists commits with start/until/path and maps timestamps', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        values: [
          {
            id: 'c1',
            displayId: 'c1',
            message: 'feat: x',
            author: { name: 'Ada', emailAddress: 'ada@example.com' },
            authorTimestamp: 1735689600000,
            parents: [{ id: 'p1' }],
          },
        ],
      }),
    );

    const commits = await provider.listCommits(slug, { ref: 'main', path: 'README.md', page: 2, perPage: 30 });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('start')).toBe('30');
    expect(url.searchParams.get('until')).toBe('main');
    expect(url.searchParams.get('path')).toBe('README.md');
    expect(commits[0]).toMatchObject({
      sha: 'c1',
      authorName: 'Ada',
      authorEmail: 'ada@example.com',
      parentShas: ['p1'],
    });
    expect(commits[0].authoredAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('maps commit changes including renames', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        isLastPage: true,
        values: [
          { type: 'RENAME', path: { toString: 'src/new.ts' }, srcPath: { toString: 'src/old.ts' } },
          { type: 'MODIFY', path: { toString: 'README.md' } },
          { type: 'DELETE', path: { toString: 'gone.ts' } },
        ],
      }),
    );

    const files = await provider.getCommitFiles(slug, 'c1');

    expect(files).toEqual([
      { path: 'src/new.ts', status: 'renamed', previousPath: 'src/old.ts' },
      { path: 'README.md', status: 'modified' },
      { path: 'gone.ts', status: 'removed' },
    ]);
  });

  it('builds web links with the at parameter', () => {
    const links = provider.webLinks(slug, 'main', 'src/app.ts');
    expect(links.fileUrl).toBe(
      'https://bitbucket.example.com/projects/ENG/repos/rocket/browse/src/app.ts?at=main',
    );
  });

  it('authenticates with a host-keyed token', async () => {
    TestBed.inject(AccessTokens).setToken('https://bitbucket.example.com', 'http_token');
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ slug: 'rocket', name: 'rocket', project: { key: 'ENG', name: 'E' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ displayId: 'main' }));

    await provider.getMetadata(slug);

    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: 'Bearer http_token' },
    });
  });

  it('maps 404s to not-found', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errors: [] }, { status: 404 }));
    await expect(provider.getMetadata(slug)).rejects.toMatchObject({ kind: 'not-found' });
  });
});
