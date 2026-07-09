import { bitbucketAuthHeader } from './bitbucket-auth';

describe('bitbucketAuthHeader', () => {
  it('returns null for an empty or whitespace-only token', () => {
    expect(bitbucketAuthHeader('')).toBeNull();
    expect(bitbucketAuthHeader('   ')).toBeNull();
  });

  it('builds Basic auth for a user:secret pair', () => {
    expect(bitbucketAuthHeader('alice:app-password')).toBe(`Basic ${btoa('alice:app-password')}`);
  });

  it('builds Bearer auth for a bare access token', () => {
    expect(bitbucketAuthHeader('repo-access-token')).toBe('Bearer repo-access-token');
  });

  it('trims surrounding whitespace before deciding the scheme', () => {
    expect(bitbucketAuthHeader('  bare-token  ')).toBe('Bearer bare-token');
    expect(bitbucketAuthHeader('  u:p  ')).toBe(`Basic ${btoa('u:p')}`);
  });
});
