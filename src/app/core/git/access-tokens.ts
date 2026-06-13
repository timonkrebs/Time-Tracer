import { Injectable, signal } from '@angular/core';

/** Hosted providers that can authenticate with a personal access token. */
export type TokenProviderId = 'github' | 'azd';

const STORAGE_PREFIX = 'time-tracer.token.';

/**
 * Optional personal access tokens, one per hosted provider — they raise API
 * rate limits and unlock private repositories. Tokens are kept only in this
 * browser (localStorage) and are attached exclusively to requests against
 * the matching provider's API host.
 */
@Injectable({ providedIn: 'root' })
export class AccessTokens {
  private readonly tokens = {
    github: signal(restore('github')),
    azd: signal(restore('azd')),
  } as const;

  /** The stored token, `''` when none. Signal-backed — reactive in views. */
  tokenFor(provider: TokenProviderId): string {
    return this.tokens[provider]();
  }

  /** Stores a token (trimmed); an empty value clears it. */
  setToken(provider: TokenProviderId, token: string): void {
    const value = token.trim();
    this.tokens[provider].set(value);
    try {
      if (value) {
        localStorage.setItem(STORAGE_PREFIX + provider, value);
      } else {
        localStorage.removeItem(STORAGE_PREFIX + provider);
      }
    } catch {
      // Storage unavailable — the token still applies for this session.
    }
  }
}

function restore(provider: TokenProviderId): string {
  try {
    return localStorage.getItem(STORAGE_PREFIX + provider) ?? '';
  } catch {
    return '';
  }
}
