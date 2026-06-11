import { parseAzdUrl } from './azd-url';

describe('parseAzdUrl', () => {
  it.each([
    [
      'https://dev.azure.com/fhnw/Services/_git/A1418-CIT.IAM.EBC/pullrequest/13619',
      { owner: 'fhnw/Services', repo: 'A1418-CIT.IAM.EBC' },
    ],
    [
      'https://dev.azure.com/fhnw/Services/_git/A1418-CIT.IAM.EBC',
      { owner: 'fhnw/Services', repo: 'A1418-CIT.IAM.EBC' },
    ],
    ['dev.azure.com/org/proj/_git/repo', { owner: 'org/proj', repo: 'repo' }],
    [
      'https://dev.azure.com/org/proj/_git/repo/commit/abc123',
      { owner: 'org/proj', repo: 'repo', ref: 'abc123' },
    ],
    [
      'https://dev.azure.com/org/proj/_git/repo?path=/src/main.ts&version=GBdevelop',
      { owner: 'org/proj', repo: 'repo', ref: 'develop', path: 'src/main.ts' },
    ],
    [
      'https://dev.azure.com/org/proj/_git/repo?version=GC0123abc',
      { owner: 'org/proj', repo: 'repo', ref: '0123abc' },
    ],
    ['https://org.visualstudio.com/proj/_git/repo', { owner: 'org/proj', repo: 'repo' }],
    ['git@ssh.dev.azure.com:v3/org/proj/repo', { owner: 'org/proj', repo: 'repo' }],
    [
      'https://dev.azure.com/org/My%20Project/_git/My%20Repo',
      { owner: 'org/My Project', repo: 'My Repo' },
    ],
  ])('parses %s', (input, expected) => {
    expect(parseAzdUrl(input)).toEqual(expected);
  });

  it.each([
    [''],
    ['https://dev.azure.com/org'],
    ['https://dev.azure.com/org/proj'],
    ['https://dev.azure.com/org/proj/_git/'],
    ['https://github.com/a/b'],
    ['owner/repo'],
  ])('rejects %s', (input) => {
    expect(parseAzdUrl(input)).toBeNull();
  });
});
