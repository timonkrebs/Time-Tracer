import { TestBed } from '@angular/core/testing';

import { RepoSlug } from '../../models';
import { AccessTokens } from '../access-tokens';
import { GitlabProvider } from './gitlab-provider';

const slug: RepoSlug = { provider: 'gitlab', owner: 'gitlab-org', repo: 'gitlab' };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

describe('GitlabProvider', () => {
  let provider: GitlabProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    provider = TestBed.inject(GitlabProvider);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('addresses projects by their URL-encoded full path', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        path: 'gitlab',
        path_with_namespace: 'gitlab-org/gitlab',
        description: 'GitLab',
        default_branch: 'master',
        web_url: 'https://gitlab.com/gitlab-org/gitlab',
        star_count: 12,
        namespace: { full_path: 'gitlab-org' },
      }),
    );

    const metadata = await provider.getMetadata(slug);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab',
    );
    expect(metadata).toMatchObject({
      fullName: 'gitlab-org/gitlab',
      defaultBranch: 'master',
      starCount: 12,
    });
  });

  it('pages through the recursive tree until a short page arrives', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: `sha${i}`,
      name: `f${i}.ts`,
      type: 'blob' as const,
      path: `src/f${i}.ts`,
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse(fullPage)).mockResolvedValueOnce(
      jsonResponse([
        { id: 'dir1', name: 'src', type: 'tree', path: 'src' },
        { id: 'sub1', name: 'vendored', type: 'commit', path: 'vendored' },
      ]),
    );

    const tree = await provider.getTree(slug, 'master');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('per_page=100&page=1&ref=master');
    expect(tree.entries).toHaveLength(102);
    expect(tree.entries.at(-2)).toMatchObject({ kind: 'dir', path: 'src' });
    expect(tree.entries.at(-1)).toMatchObject({ kind: 'submodule', path: 'vendored' });
    expect(tree.truncated).toBe(false);
  });

  it('maps an empty tree to an empty-repo error', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    await expect(provider.getTree(slug, 'master')).rejects.toMatchObject({ kind: 'empty-repo' });
  });

  it('fetches historical file content with an encoded path', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        blob_id: 'b1',
        size: 6,
        encoding: 'base64',
        content: btoa('hello\n'),
      }),
    );

    const file = await provider.getFileAtRef(slug, 'docs/my file.md', 'abc');

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab/repository/files/docs%2Fmy%20file.md?ref=abc',
    );
    expect(file).toMatchObject({ kind: 'text', text: 'hello\n', sha: 'b1' });
  });

  it('lists commits with ref and path filters', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          id: 'c1',
          message: 'feat: x\n\nbody',
          title: 'feat: x',
          author_name: 'Ada',
          author_email: 'ada@example.com',
          authored_date: '2026-01-01T00:00:00Z',
          web_url: 'https://gitlab.com/gitlab-org/gitlab/-/commit/c1',
          parent_ids: ['p1'],
        },
      ]),
    );

    const commits = await provider.listCommits(slug, { ref: 'master', path: 'README.md' });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('ref_name')).toBe('master');
    expect(url.searchParams.get('path')).toBe('README.md');
    expect(commits[0]).toMatchObject({ sha: 'c1', summary: 'feat: x', parentShas: ['p1'] });
  });

  it('maps commit diffs including rename detection', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          old_path: 'src/old.ts',
          new_path: 'src/new.ts',
          new_file: false,
          renamed_file: true,
          deleted_file: false,
        },
        {
          old_path: 'README.md',
          new_path: 'README.md',
          new_file: false,
          renamed_file: false,
          deleted_file: false,
        },
      ]),
    );

    const files = await provider.getCommitFiles(slug, 'c1');

    expect(files).toEqual([
      { path: 'src/new.ts', status: 'renamed', previousPath: 'src/old.ts' },
      { path: 'README.md', status: 'modified' },
    ]);
  });

  it('builds GitLab web links', () => {
    const links = provider.webLinks(slug, 'master', 'app/models/user.rb');
    expect(links?.fileUrl).toBe(
      'https://gitlab.com/gitlab-org/gitlab/-/blob/master/app/models/user.rb',
    );
    expect(links?.rawFileUrl).toBe(
      'https://gitlab.com/gitlab-org/gitlab/-/raw/master/app/models/user.rb',
    );
  });

  it('recognises GitLab inputs via canHandle', () => {
    expect(provider.canHandle('https://gitlab.com/gitlab-org/gitlab.git')).toBe(true);
    expect(provider.canHandle('https://github.com/a/b')).toBe(false);
    expect(provider.canHandle('a/b')).toBe(false);
  });

  it('maps 404s to not-found', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Not Found' }, { status: 404 }));

    await expect(provider.getMetadata(slug)).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('sends a stored token as PRIVATE-TOKEN', async () => {
    TestBed.inject(AccessTokens).setToken('gitlab', 'glpat-secret');
    fetchMock.mockResolvedValue(
      jsonResponse({
        path: 'gitlab',
        path_with_namespace: 'gitlab-org/gitlab',
        description: null,
        default_branch: 'main',
        web_url: 'https://gitlab.com/gitlab-org/gitlab',
        star_count: 0,
        namespace: { full_path: 'gitlab-org' },
      }),
    );

    await provider.getMetadata(slug);

    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { 'PRIVATE-TOKEN': 'glpat-secret' },
    });
  });

  describe('self-hosted host', () => {
    const selfHosted: RepoSlug = {
      provider: 'gitlab',
      owner: 'group',
      repo: 'project',
      host: 'https://gitlab.example.com',
    };

    it('targets the instance /api/v4 base with its host-keyed token', async () => {
      TestBed.inject(AccessTokens).setToken('https://gitlab.example.com', 'glpat-self');
      fetchMock.mockResolvedValue(
        jsonResponse({
          path: 'project',
          path_with_namespace: 'group/project',
          description: null,
          default_branch: 'main',
          web_url: 'https://gitlab.example.com/group/project',
          star_count: 0,
          namespace: { full_path: 'group' },
        }),
      );

      await provider.getMetadata(selfHosted);

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://gitlab.example.com/api/v4/projects/group%2Fproject',
      );
      expect(fetchMock.mock.calls[0][1]).toMatchObject({
        headers: { 'PRIVATE-TOKEN': 'glpat-self' },
      });
    });
  });
});
