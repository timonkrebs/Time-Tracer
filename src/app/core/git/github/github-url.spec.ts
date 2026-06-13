import { parseGithubUrl } from './github-url';

describe('parseGithubUrl', () => {
  it.each([
    ['angular/angular', { owner: 'angular', repo: 'angular' }],
    ['owner/repo.git', { owner: 'owner', repo: 'repo' }],
    ['  spaced/input  ', { owner: 'spaced', repo: 'input' }],
    ['https://github.com/angular/angular', { owner: 'angular', repo: 'angular' }],
    ['https://github.com/angular/angular/', { owner: 'angular', repo: 'angular' }],
    ['https://github.com/angular/angular.git', { owner: 'angular', repo: 'angular' }],
    ['http://www.github.com/a/b', { owner: 'a', repo: 'b' }],
    ['github.com/a/b', { owner: 'a', repo: 'b' }],
    ['www.github.com/a/b', { owner: 'a', repo: 'b' }],
    ['git@github.com:a/b.git', { owner: 'a', repo: 'b' }],
    ['git@github.com:a/b', { owner: 'a', repo: 'b' }],
    ['https://github.com/a/b/tree/main', { owner: 'a', repo: 'b', ref: 'main' }],
    [
      'https://github.com/a/b/tree/v1.2.3/src/lib',
      { owner: 'a', repo: 'b', ref: 'v1.2.3', path: 'src/lib' },
    ],
    [
      'https://github.com/a/b/blob/main/src/main.ts',
      { owner: 'a', repo: 'b', ref: 'main', path: 'src/main.ts' },
    ],
    ['https://github.com/a/b/commit/0123abc', { owner: 'a', repo: 'b', ref: '0123abc' }],
    [
      'https://raw.githubusercontent.com/a/b/main/README.md',
      { owner: 'a', repo: 'b', ref: 'main', path: 'README.md' },
    ],
    // Other repo sub-pages still identify the repository.
    ['https://github.com/a/b/issues/42', { owner: 'a', repo: 'b' }],
    ['https://github.com/a/b/pulls', { owner: 'a', repo: 'b' }],
  ])('parses %s', (input, expected) => {
    expect(parseGithubUrl(input)).toEqual(expected);
  });

  it.each([
    [''],
    ['   '],
    ['justoneword'],
    ['a/b/c'],
    ['https://gitlab.com/a/b'],
    ['https://github.com/onlyowner'],
    ['https://github.com/'],
    ['ftp://github.com/a/b'],
    ['-bad/owner'],
    ['owner/sp ace'],
  ])('rejects %s', (input) => {
    expect(parseGithubUrl(input)).toBeNull();
  });

  it('decodes percent-encoded path segments', () => {
    expect(parseGithubUrl('https://github.com/a/b/blob/main/docs/my%20file.md')).toEqual({
      owner: 'a',
      repo: 'b',
      ref: 'main',
      path: 'docs/my file.md',
    });
  });

  describe('GitHub Enterprise host', () => {
    const host = 'https://github.example.com';

    it.each([
      ['a/b', { owner: 'a', repo: 'b', host }],
      ['https://github.example.com/a/b', { owner: 'a', repo: 'b', host }],
      ['github.example.com/a/b', { owner: 'a', repo: 'b', host }],
      [
        'https://github.example.com/a/b/blob/main/src/x.ts',
        { owner: 'a', repo: 'b', ref: 'main', path: 'src/x.ts', host },
      ],
      ['git@github.example.com:a/b.git', { owner: 'a', repo: 'b', host }],
    ])('parses %s against the host', (input, expected) => {
      expect(parseGithubUrl(input, host)).toEqual(expected);
    });

    it('rejects a URL on a different host', () => {
      expect(parseGithubUrl('https://github.com/a/b', host)).toBeNull();
    });
  });
});
