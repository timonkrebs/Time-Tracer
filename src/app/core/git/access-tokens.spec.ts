import { TestBed } from '@angular/core/testing';

import { AccessTokens } from './access-tokens';

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
});
