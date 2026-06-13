import { TestBed } from '@angular/core/testing';

import { AccessTokens, hostKey, tokenKeyForSlug } from './access-tokens';

describe('AccessTokens', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('stores, trims and clears tokens per provider', () => {
    const tokens = TestBed.inject(AccessTokens);

    tokens.setToken('github', '  ghp_secret  ');
    expect(tokens.tokenFor('github')).toBe('ghp_secret');
    expect(localStorage.getItem('time-tracer.token.github')).toBe('ghp_secret');
    expect(tokens.tokenFor('azd')).toBe('');

    tokens.setToken('github', '');
    expect(tokens.tokenFor('github')).toBe('');
    expect(localStorage.getItem('time-tracer.token.github')).toBeNull();
  });

  it('restores stored tokens on creation', () => {
    localStorage.setItem('time-tracer.token.azd', 'azd-pat');

    expect(TestBed.inject(AccessTokens).tokenFor('azd')).toBe('azd-pat');
  });

  it('keys self-hosted tokens by instance origin', () => {
    const tokens = TestBed.inject(AccessTokens);
    const slug = { provider: 'github', host: 'https://ghe.example.com' };

    tokens.setToken(tokenKeyForSlug(slug), 'ghe-pat');

    expect(tokenKeyForSlug(slug)).toBe('https://ghe.example.com');
    expect(tokens.tokenForSlug(slug)).toBe('ghe-pat');
    // A public-host slug of the same provider keeps a separate token.
    expect(tokens.tokenForSlug({ provider: 'github' })).toBe('');
  });

  it('normalises a scheme-less host to the same key', () => {
    expect(hostKey('git.example.com')).toBe('https://git.example.com');
    expect(hostKey('https://git.example.com/')).toBe('https://git.example.com');
  });
});
