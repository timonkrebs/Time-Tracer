import { parseBitbucketServerUrl } from './bitbucket-server-url';

const HOST = 'https://bitbucket.example.com';

describe('parseBitbucketServerUrl', () => {
  it.each([
    ['ENG/rocket', { owner: 'ENG', repo: 'rocket', host: HOST }],
    [
      'https://bitbucket.example.com/projects/ENG/repos/rocket',
      { owner: 'ENG', repo: 'rocket', host: HOST },
    ],
    [
      'https://bitbucket.example.com/projects/ENG/repos/rocket/browse/src/app.ts?at=refs/heads/main',
      { owner: 'ENG', repo: 'rocket', ref: 'main', path: 'src/app.ts', host: HOST },
    ],
    [
      'https://bitbucket.example.com/projects/ENG/repos/rocket/commits/abc123',
      { owner: 'ENG', repo: 'rocket', ref: 'abc123', host: HOST },
    ],
    [
      'https://bitbucket.example.com/scm/eng/rocket.git',
      { owner: 'eng', repo: 'rocket', host: HOST },
    ],
    [
      'https://bitbucket.example.com/users/ada/repos/rocket/browse',
      { owner: '~ada', repo: 'rocket', host: HOST },
    ],
    [
      'ssh://git@bitbucket.example.com:7999/ENG/rocket.git',
      { owner: 'ENG', repo: 'rocket', host: HOST },
    ],
    ['git@bitbucket.example.com:ENG/rocket.git', { owner: 'ENG', repo: 'rocket', host: HOST }],
  ])('parses %s', (input, expected) => {
    expect(parseBitbucketServerUrl(input, HOST)).toEqual(expected);
  });

  it('strips a tag ref prefix from the at parameter', () => {
    expect(
      parseBitbucketServerUrl(
        'https://bitbucket.example.com/projects/ENG/repos/rocket/browse?at=refs/tags/v1.0',
        HOST,
      ),
    ).toEqual({ owner: 'ENG', repo: 'rocket', ref: 'v1.0', host: HOST });
  });

  it('normalises a scheme-less host', () => {
    expect(parseBitbucketServerUrl('ENG/rocket', 'bitbucket.example.com')).toEqual({
      owner: 'ENG',
      repo: 'rocket',
      host: HOST,
    });
  });

  it.each([[''], ['   '], ['onlyone'], ['https://other.example.com/projects/ENG/repos/rocket']])(
    'rejects %s',
    (input) => {
      expect(parseBitbucketServerUrl(input, HOST)).toBeNull();
    },
  );
});
