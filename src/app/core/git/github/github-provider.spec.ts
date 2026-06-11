import { TestBed } from '@angular/core/testing';

import { RepoProviderError, RepoSlug, TreeEntry } from '../../models';
import { GithubProvider, MAX_FILE_SIZE_BYTES } from './github-provider';

const slug: RepoSlug = { provider: 'github', owner: 'acme', repo: 'rocket' };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('GithubProvider', () => {
  let provider: GithubProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    provider = TestBed.inject(GithubProvider);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests metadata with the GitHub media type headers', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        name: 'rocket',
        full_name: 'acme/rocket',
        description: 'desc',
        default_branch: 'main',
        html_url: 'https://github.com/acme/rocket',
        stargazers_count: 7,
        fork: false,
        owner: { login: 'acme' },
      }),
    );

    const metadata = await provider.getMetadata(slug);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/rocket',
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/vnd.github+json' }),
      }),
    );
    expect(metadata).toMatchObject({
      fullName: 'acme/rocket',
      defaultBranch: 'main',
      starCount: 7,
    });
  });

  it('maps tree entries including submodules', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        truncated: true,
        tree: [
          { path: 'src', type: 'tree', sha: 't1' },
          { path: 'src/main.ts', type: 'blob', sha: 'b1', size: 42 },
          { path: 'vendored', type: 'commit', sha: 'c1' },
        ],
      }),
    );

    const tree = await provider.getTree(slug, 'main');

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/acme/rocket/git/trees/main?recursive=1',
    );
    expect(tree.truncated).toBe(true);
    expect(tree.entries).toEqual([
      { path: 'src', name: 'src', kind: 'dir', sha: 't1' },
      { path: 'src/main.ts', name: 'main.ts', kind: 'file', sha: 'b1', size: 42 },
      { path: 'vendored', name: 'vendored', kind: 'submodule', sha: 'c1' },
    ]);
  });

  it('decodes text blobs from base64 with embedded newlines', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ sha: 'b1', size: 11, content: 'aGVsbG8g\nd29ybGQ=\n', encoding: 'base64' }),
    );
    const entry: TreeEntry = {
      path: 'hello.txt',
      name: 'hello.txt',
      kind: 'file',
      sha: 'b1',
      size: 11,
    };

    const repoFile = await provider.getFile(slug, entry);

    expect(repoFile).toEqual({
      kind: 'text',
      path: 'hello.txt',
      sha: 'b1',
      size: 11,
      text: 'hello world',
    });
  });

  it('detects binary blobs via NUL bytes', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a]);
    const base64 = btoa(String.fromCharCode(...bytes));
    fetchMock.mockResolvedValue(
      jsonResponse({ sha: 'b2', size: bytes.length, content: base64, encoding: 'base64' }),
    );
    const entry: TreeEntry = {
      path: 'logo.png',
      name: 'logo.png',
      kind: 'file',
      sha: 'b2',
      size: 6,
    };

    const repoFile = await provider.getFile(slug, entry);

    expect(repoFile.kind).toBe('binary');
  });

  it('short-circuits oversized files without a network call', async () => {
    const entry: TreeEntry = {
      path: 'big.bin',
      name: 'big.bin',
      kind: 'file',
      sha: 'b3',
      size: MAX_FILE_SIZE_BYTES + 1,
    };

    const repoFile = await provider.getFile(slug, entry);

    expect(repoFile.kind).toBe('too-large');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps 404s to not-found', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Not Found' }, { status: 404 }));

    await expect(provider.getMetadata(slug)).rejects.toMatchObject({
      name: 'RepoProviderError',
      kind: 'not-found',
    });
  });

  it('maps a 404 on the tree endpoint to invalid-ref', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Not Found' }, { status: 404 }));

    await expect(provider.getTree(slug, 'nope')).rejects.toMatchObject({ kind: 'invalid-ref' });
  });

  it('maps exhausted rate limits with the reset time', async () => {
    const resetEpoch = 1900000000;
    fetchMock.mockResolvedValue(
      jsonResponse(
        { message: 'API rate limit exceeded' },
        {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(resetEpoch),
          },
        },
      ),
    );

    const error = await provider.getMetadata(slug).catch((e: unknown) => e as RepoProviderError);

    expect(error).toBeInstanceOf(RepoProviderError);
    expect(error as RepoProviderError).toMatchObject({ kind: 'rate-limited' });
    expect((error as RepoProviderError).rateLimitResetAt).toEqual(new Date(resetEpoch * 1000));
  });

  it('maps 409 to empty-repo', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: 'Git Repository is empty.' }, { status: 409 }),
    );

    await expect(provider.getTree(slug, 'main')).rejects.toMatchObject({ kind: 'empty-repo' });
  });

  it('maps fetch failures to network errors', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(provider.getMetadata(slug)).rejects.toMatchObject({ kind: 'network' });
  });

  it('lists commits with ref and path filters', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          sha: 'abc',
          html_url: 'https://github.com/acme/rocket/commit/abc',
          commit: {
            message: 'feat: add engine\n\nBody text',
            author: { name: 'Ada', email: 'ada@example.com', date: '2026-01-01T00:00:00Z' },
          },
          parents: [{ sha: 'p1' }, { sha: 'p2' }],
        },
      ]),
    );

    const commits = await provider.listCommits(slug, { ref: 'main', path: 'src/main.ts' });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/repos/acme/rocket/commits');
    expect(url.searchParams.get('sha')).toBe('main');
    expect(url.searchParams.get('path')).toBe('src/main.ts');
    expect(commits[0]).toMatchObject({
      sha: 'abc',
      summary: 'feat: add engine',
      authorName: 'Ada',
      parentShas: ['p1', 'p2'],
    });
  });

  it('builds web links with encoded paths', () => {
    const links = provider.webLinks(slug, 'main', 'docs/my file.md');
    expect(links.fileUrl).toBe('https://github.com/acme/rocket/blob/main/docs/my%20file.md');
    expect(links.rawFileUrl).toBe(
      'https://raw.githubusercontent.com/acme/rocket/main/docs/my%20file.md',
    );
  });

  it('resolves a branch name containing slashes', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([{ ref: 'refs/heads/claude/brave-hamilton' }, { ref: 'refs/heads/claudette' }]),
    );

    const resolved = await provider.resolveRefPath(slug, 'claude/brave-hamilton');

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/acme/rocket/git/matching-refs/heads/claude',
    );
    expect(resolved).toEqual({ ref: 'claude/brave-hamilton' });
  });

  it('splits ref and path at the matching branch boundary', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ ref: 'refs/heads/feature/foo' }]));

    const resolved = await provider.resolveRefPath(slug, 'feature/foo/src/main.ts');

    expect(resolved).toEqual({ ref: 'feature/foo', path: 'src/main.ts' });
  });

  it('falls back to tags when no branch matches', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{ ref: 'refs/tags/release/1.0' }]));

    const resolved = await provider.resolveRefPath(slug, 'release/1.0/docs');

    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.github.com/repos/acme/rocket/git/matching-refs/tags/release',
    );
    expect(resolved).toEqual({ ref: 'release/1.0', path: 'docs' });
  });

  it('resolves null when no ref matches the combined string', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ ref: 'refs/heads/main-old' }]));

    await expect(provider.resolveRefPath(slug, 'main/packages')).resolves.toBeNull();
  });

  it('resolves null instead of rejecting when the ref lookup fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(provider.resolveRefPath(slug, 'feature/foo')).resolves.toBeNull();
  });

  it('recognises GitHub inputs via canHandle', () => {
    expect(provider.canHandle('https://github.com/a/b')).toBe(true);
    expect(provider.canHandle('a/b')).toBe(true);
    expect(provider.canHandle('https://example.com/a/b')).toBe(false);
  });
});
