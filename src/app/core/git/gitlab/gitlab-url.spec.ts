import { parseGitlabUrl } from './gitlab-url';

describe('parseGitlabUrl', () => {
  it.each([
    ['https://gitlab.com/gitlab-org/gitlab.git', { owner: 'gitlab-org', repo: 'gitlab' }],
    ['https://gitlab.com/gitlab-org/gitlab', { owner: 'gitlab-org', repo: 'gitlab' }],
    ['https://gitlab.com/gitlab-org/gitlab/', { owner: 'gitlab-org', repo: 'gitlab' }],
    ['gitlab.com/owner/repo', { owner: 'owner', repo: 'repo' }],
    ['git@gitlab.com:owner/repo.git', { owner: 'owner', repo: 'repo' }],
    // Nested groups: everything before the project becomes the owner.
    ['https://gitlab.com/group/subgroup/project', { owner: 'group/subgroup', repo: 'project' }],
    [
      'https://gitlab.com/gitlab-org/gitlab/-/tree/master',
      { owner: 'gitlab-org', repo: 'gitlab', ref: 'master' },
    ],
    [
      'https://gitlab.com/gitlab-org/gitlab/-/tree/master/app/models',
      { owner: 'gitlab-org', repo: 'gitlab', ref: 'master', path: 'app/models' },
    ],
    [
      'https://gitlab.com/gitlab-org/gitlab/-/blob/master/README.md',
      { owner: 'gitlab-org', repo: 'gitlab', ref: 'master', path: 'README.md' },
    ],
    [
      'https://gitlab.com/gitlab-org/gitlab/-/commit/abc123',
      { owner: 'gitlab-org', repo: 'gitlab', ref: 'abc123' },
    ],
    // Other sub-pages still identify the project.
    ['https://gitlab.com/gitlab-org/gitlab/-/issues', { owner: 'gitlab-org', repo: 'gitlab' }],
  ])('parses %s', (input, expected) => {
    expect(parseGitlabUrl(input)).toEqual(expected);
  });

  it.each([
    [''],
    ['https://gitlab.com/onlygroup'],
    ['https://github.com/a/b'],
    ['owner/repo'],
    ['ftp://gitlab.com/a/b'],
  ])('rejects %s', (input) => {
    expect(parseGitlabUrl(input)).toBeNull();
  });

  describe('self-hosted host', () => {
    const host = 'https://gitlab.example.com';

    it.each([
      ['group/sub/project', { owner: 'group/sub', repo: 'project', host }],
      ['https://gitlab.example.com/group/project', { owner: 'group', repo: 'project', host }],
      [
        'https://gitlab.example.com/group/project/-/blob/main/README.md',
        { owner: 'group', repo: 'project', ref: 'main', path: 'README.md', host },
      ],
      ['git@gitlab.example.com:group/project.git', { owner: 'group', repo: 'project', host }],
    ])('parses %s against the host', (input, expected) => {
      expect(parseGitlabUrl(input, host)).toEqual(expected);
    });

    it('rejects a URL on a different host', () => {
      expect(parseGitlabUrl('https://gitlab.com/a/b', host)).toBeNull();
    });
  });
});
