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

  describe('getFileAtRef', () => {
    it('fetches historical content through the contents API', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          type: 'file',
          path: 'src/main.ts',
          sha: 'old1',
          size: 9,
          content: btoa('old text\n'),
          encoding: 'base64',
        }),
      );

      const file = await provider.getFileAtRef(slug, 'src/main.ts', 'abc123');

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.github.com/repos/acme/rocket/contents/src/main.ts?ref=abc123',
      );
      expect(file).toEqual({
        kind: 'text',
        path: 'src/main.ts',
        sha: 'old1',
        size: 9,
        text: 'old text\n',
      });
    });

    it('falls back to the blob endpoint when inline content is omitted', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            type: 'file',
            path: 'big.txt',
            sha: 'bigsha',
            size: 1_500_000,
            content: '',
            encoding: 'none',
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            sha: 'bigsha',
            size: 12,
            content: btoa('blob content'),
            encoding: 'base64',
          }),
        );

      const file = await provider.getFileAtRef(slug, 'big.txt', 'abc123');

      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://api.github.com/repos/acme/rocket/git/blobs/bigsha',
      );
      expect(file).toMatchObject({ kind: 'text', text: 'blob content' });
    });

    it('short-circuits oversized historical files', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          type: 'file',
          path: 'huge.bin',
          sha: 'h1',
          size: MAX_FILE_SIZE_BYTES + 1,
          content: '',
          encoding: 'none',
        }),
      );

      const file = await provider.getFileAtRef(slug, 'huge.bin', 'abc123');

      expect(file.kind).toBe('too-large');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('maps a missing path at the ref to not-found', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ message: 'Not Found' }, { status: 404 }));

      await expect(provider.getFileAtRef(slug, 'gone.ts', 'abc123')).rejects.toMatchObject({
        kind: 'not-found',
      });
    });

    it('rejects when the path is a directory at the ref', async () => {
      fetchMock.mockResolvedValue(jsonResponse([{ type: 'file', path: 'dir/a.ts' }]));

      await expect(provider.getFileAtRef(slug, 'dir', 'abc123')).rejects.toMatchObject({
        kind: 'unknown',
      });
    });
  });

  describe('getCommit', () => {
    it('fetches and maps a single commit', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          sha: 'abc',
          html_url: 'https://github.com/acme/rocket/commit/abc',
          commit: {
            message: 'fix: tighten bolts\n\nDetails.',
            author: { name: 'Ada', email: 'ada@example.com', date: '2026-02-02T00:00:00Z' },
          },
          parents: [{ sha: 'p1' }],
        }),
      );

      const commit = await provider.getCommit(slug, 'abc');

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.github.com/repos/acme/rocket/commits/abc',
      );
      expect(commit).toMatchObject({
        sha: 'abc',
        summary: 'fix: tighten bolts',
        parentShas: ['p1'],
      });
    });

    it('maps an unknown sha to not-found', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ message: 'Not Found' }, { status: 404 }));

      await expect(provider.getCommit(slug, 'nope')).rejects.toMatchObject({
        kind: 'not-found',
      });
    });
  });

  describe('getCommitFiles', () => {
    it('maps touched files including rename detection', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          sha: 'abc',
          html_url: 'https://github.com/acme/rocket/commit/abc',
          commit: { message: 'refactor: move', author: null },
          parents: [{ sha: 'p1' }],
          files: [
            { filename: 'src/engine.ts', status: 'renamed', previous_filename: 'src/thruster.ts' },
            { filename: 'README.md', status: 'modified' },
          ],
        }),
      );

      const files = await provider.getCommitFiles(slug, 'abc');

      expect(files).toEqual([
        { path: 'src/engine.ts', status: 'renamed', previousPath: 'src/thruster.ts' },
        { path: 'README.md', status: 'modified' },
      ]);
    });

    it('returns an empty list when the response omits files', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          sha: 'abc',
          html_url: 'https://github.com/acme/rocket/commit/abc',
          commit: { message: 'x', author: null },
          parents: [],
        }),
      );

      await expect(provider.getCommitFiles(slug, 'abc')).resolves.toEqual([]);
    });
  });
});
