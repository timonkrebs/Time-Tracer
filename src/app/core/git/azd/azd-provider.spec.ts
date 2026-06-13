import { TestBed } from '@angular/core/testing';

import { RepoSlug } from '../../models';
import { AccessTokens } from '../access-tokens';
import { AzdProvider } from './azd-provider';

const slug: RepoSlug = { provider: 'azd', owner: 'fhnw/Services', repo: 'A1418-CIT.IAM.EBC' };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('AzdProvider', () => {
  let provider: AzdProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    provider = TestBed.inject(AzdProvider);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads repository metadata and strips the refs/heads prefix', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        name: 'A1418-CIT.IAM.EBC',
        defaultBranch: 'refs/heads/develop',
        webUrl: 'https://dev.azure.com/fhnw/Services/_git/A1418-CIT.IAM.EBC',
        project: { name: 'Services' },
      }),
    );

    const metadata = await provider.getMetadata(slug);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://dev.azure.com/fhnw/Services/_apis/git/repositories/A1418-CIT.IAM.EBC?api-version=7.1',
    );
    expect(metadata).toMatchObject({
      fullName: 'fhnw/Services/A1418-CIT.IAM.EBC',
      defaultBranch: 'develop',
    });
  });

  it('maps the recursive item listing to tree entries', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        value: [
          { path: '/', objectId: 'root', gitObjectType: 'tree', isFolder: true },
          { path: '/src', objectId: 't1', gitObjectType: 'tree', isFolder: true },
          { path: '/src/main.ts', objectId: 'b1', gitObjectType: 'blob', size: 42 },
        ],
      }),
    );

    const tree = await provider.getTree(slug, 'develop');

    expect(fetchMock.mock.calls[0][0]).toContain(
      'items?recursionLevel=full&versionDescriptor.version=develop&versionDescriptor.versionType=branch',
    );
    expect(tree.entries).toEqual([
      { path: 'src', name: 'src', kind: 'dir', sha: 't1' },
      { path: 'src/main.ts', name: 'main.ts', kind: 'file', sha: 'b1', size: 42 },
    ]);
  });

  it('uses versionType=commit for sha refs', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ value: [{ path: '/a.txt', objectId: 'b1', gitObjectType: 'blob' }] }),
    );

    await provider.getTree(slug, 'a'.repeat(40));

    expect(fetchMock.mock.calls[0][0]).toContain('versionDescriptor.versionType=commit');
  });

  it('fetches historical files in two steps: item metadata, then the blob', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ path: '/src/main.ts', objectId: 'blob9', gitObjectType: 'blob', size: 6 }),
      )
      .mockResolvedValueOnce(
        new Response(new TextEncoder().encode('hello\n'), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
      );

    const file = await provider.getFileAtRef(slug, 'src/main.ts', 'b'.repeat(40));

    expect(fetchMock.mock.calls[0][0]).toContain('items?path=%2Fsrc%2Fmain.ts');
    expect(fetchMock.mock.calls[1][0]).toContain('/blobs/blob9?$format=octetStream');
    expect(file).toMatchObject({ kind: 'text', text: 'hello\n', sha: 'blob9' });
  });

  it('lists commits with itemPath and paging criteria (parents unknown)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        value: [
          {
            commitId: 'c1',
            comment: 'feat: x',
            author: { name: 'Kay', email: 'kay@fhnw.ch', date: '2022-07-08T00:00:00Z' },
          },
        ],
      }),
    );

    const commits = await provider.listCommits(slug, {
      ref: 'develop',
      path: 'src/main.ts',
      perPage: 10,
      page: 2,
    });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('searchCriteria.itemPath=%2Fsrc%2Fmain.ts');
    expect(url).toContain('searchCriteria.%24top=10');
    expect(url).toContain('searchCriteria.%24skip=10');
    expect(commits[0]).toMatchObject({ sha: 'c1', authorName: 'Kay', parentShas: [] });
  });

  it('resolves single commits including parents', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        commitId: 'c1',
        comment: 'feat: x',
        parents: ['p1'],
        author: { name: 'Kay', date: '2022-07-08T00:00:00Z' },
      }),
    );

    const commit = await provider.getCommit(slug, 'c1');

    expect(commit.parentShas).toEqual(['p1']);
  });

  it('maps commit changes including renames', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        changes: [
          {
            changeType: 'edit, rename',
            sourceServerItem: '/old/name.ts',
            item: { path: '/new/name.ts' },
          },
          { changeType: 'edit', item: { path: '/README.md' } },
          { changeType: 'edit', item: { path: '/src', isFolder: true } },
        ],
      }),
    );

    const files = await provider.getCommitFiles(slug, 'c1');

    expect(files).toEqual([
      { path: 'new/name.ts', status: 'renamed', previousPath: 'old/name.ts' },
      { path: 'README.md', status: 'modified' },
    ]);
  });

  it('explains anonymous access to private projects (sign-in answer)', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>Sign in</html>', {
        status: 203,
        headers: { 'content-type': 'text/html' },
      }),
    );

    await expect(provider.getMetadata(slug)).rejects.toMatchObject({
      kind: 'not-found',
      message: expect.stringContaining('sign-in'),
    });
  });

  it('authenticates with a stored personal access token (Basic, empty user)', async () => {
    TestBed.inject(AccessTokens).setToken('azd', 'azd-pat');
    fetchMock.mockResolvedValue(
      jsonResponse({
        name: 'A1418-CIT.IAM.EBC',
        defaultBranch: 'refs/heads/main',
        webUrl: 'https://dev.azure.com/fhnw/Services/_git/A1418-CIT.IAM.EBC',
        project: { name: 'Services' },
      }),
    );

    await provider.getMetadata(slug);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Basic ${btoa(':azd-pat')}` }),
      }),
    );
  });

  it('explains a rejected token instead of blaming anonymity', async () => {
    TestBed.inject(AccessTokens).setToken('azd', 'expired-pat');
    fetchMock.mockResolvedValue(
      new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }),
    );

    await expect(provider.getMetadata(slug)).rejects.toMatchObject({
      message: expect.stringContaining('rejected the access token'),
    });
  });

  it('builds web links with GB/GC version selectors', () => {
    expect(provider.webLinks(slug, 'develop', 'src/main.ts')?.fileUrl).toContain(
      'version=GBdevelop',
    );
    expect(provider.webLinks(slug, 'a'.repeat(40), 'src/main.ts')?.fileUrl).toContain(
      `version=GC${'a'.repeat(40)}`,
    );
  });

  it('recognises Azure DevOps inputs via canHandle', () => {
    expect(
      provider.canHandle(
        'https://dev.azure.com/fhnw/Services/_git/A1418-CIT.IAM.EBC/pullrequest/13619',
      ),
    ).toBe(true);
    expect(provider.canHandle('https://github.com/a/b')).toBe(false);
  });
});
