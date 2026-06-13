import { parseBitbucketCloudUrl } from './bitbucket-cloud-url';

describe('parseBitbucketCloudUrl', () => {
  it.each([
    ['https://bitbucket.org/acme/rocket', { owner: 'acme', repo: 'rocket' }],
    ['https://bitbucket.org/acme/rocket/', { owner: 'acme', repo: 'rocket' }],
    ['https://bitbucket.org/acme/rocket.git', { owner: 'acme', repo: 'rocket' }],
    ['bitbucket.org/acme/rocket', { owner: 'acme', repo: 'rocket' }],
    ['git@bitbucket.org:acme/rocket.git', { owner: 'acme', repo: 'rocket' }],
    [
      'https://bitbucket.org/acme/rocket/src/main/src/app.ts',
      { owner: 'acme', repo: 'rocket', ref: 'main', path: 'src/app.ts' },
    ],
    [
      'https://bitbucket.org/acme/rocket/src/abc123',
      { owner: 'acme', repo: 'rocket', ref: 'abc123' },
    ],
    [
      'https://bitbucket.org/acme/rocket/commits/abc123',
      { owner: 'acme', repo: 'rocket', ref: 'abc123' },
    ],
    // Other sub-pages still identify the repo.
    ['https://bitbucket.org/acme/rocket/pull-requests/4', { owner: 'acme', repo: 'rocket' }],
  ])('parses %s', (input, expected) => {
    expect(parseBitbucketCloudUrl(input)).toEqual(expected);
  });

  it.each([
    [''],
    ['   '],
    ['acme/rocket'],
    ['https://github.com/a/b'],
    ['https://bitbucket.org/onlyworkspace'],
    ['ftp://bitbucket.org/a/b'],
  ])('rejects %s', (input) => {
    expect(parseBitbucketCloudUrl(input)).toBeNull();
  });

  it('decodes percent-encoded path segments', () => {
    expect(parseBitbucketCloudUrl('https://bitbucket.org/a/b/src/main/docs/my%20file.md')).toEqual({
      owner: 'a',
      repo: 'b',
      ref: 'main',
      path: 'docs/my file.md',
    });
  });
});
