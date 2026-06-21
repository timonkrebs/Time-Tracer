import { Injectable, WritableSignal, signal } from '@angular/core';

import { RepoSlug } from '../models';

/** Public hosted providers with a built-in personal-access-token field. */
export type TokenProviderId = 'github' | 'gitlab' | 'azd' | 'bitbucket';

const STORAGE_PREFIX = 'time-tracer.token.';

/**
 * The token key for a repository: the instance origin for a self-hosted
 * instance — so every GitHub Enterprise, self-hosted GitLab and Bitbucket
 * Server keeps its own token — or the provider id for the public hosts
 * (github.com, gitlab.com, bitbucket.org, Azure DevOps).
 */
export function tokenKeyForSlug(slug: Pick<RepoSlug, 'provider' | 'host'>): string {
  return slug.host ? hostKey(slug.host) : slug.provider;
}

/**
 * Normalises a host to its origin so a scheme-less entry, a trailing slash or
 * a path don't fork the key (and stay in step with the origin the provider's
 * slug carries).
 */
export function hostKey(host: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `https://${host}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return host.replace(/\/+$/, '');
  }
}

/**
 * Optional personal access tokens, keyed per host — they raise API rate
 * limits and unlock private repositories. Tokens are kept only in this
 * browser (localStorage) and are attached exclusively to requests against
 * the matching instance's API.
 */
@Injectable({ providedIn: 'root' })
export class AccessTokens {
  /** Lazily-created reactive cell per key, restored from localStorage. */
  private readonly cells = new Map<string, WritableSignal<string>>();

  /**
   * The stored token for a key, `''` when none.
   *
   * Signal-backed — reads inside `computed()` / `effect()` / templates are
   * tracked by Angular's reactive graph and will re-run when the token
   * changes (e.g. when the user saves or clears it on the start page).
   */
  tokenFor(key: string): string {
    return this.cell(key)();
  }

  /**
   * The stored token for a repository (host- or provider-keyed).
   *
   * Signal-backed — reactive in templates and computed signals; updates
   * automatically when the token for the matching host/provider changes.
   */
  tokenForSlug(slug: Pick<RepoSlug, 'provider' | 'host'>): string {
    return this.tokenFor(tokenKeyForSlug(slug));
  }

  /** Stores a token (trimmed); an empty value clears it. */
  setToken(key: string, token: string): void {
    const value = token.trim();
    this.cell(key).set(value);
    try {
      if (value) {
        localStorage.setItem(STORAGE_PREFIX + key, value);
      } else {
        localStorage.removeItem(STORAGE_PREFIX + key);
      }
    } catch {
      // Storage unavailable — the token still applies for this session.
    }
  }

  private cell(key: string): WritableSignal<string> {
    let cell = this.cells.get(key);
    if (!cell) {
      cell = signal(restore(key));
      this.cells.set(key, cell);
    }
    return cell;
  }
}

function restore(key: string): string {
  try {
    return localStorage.getItem(STORAGE_PREFIX + key) ?? '';
  } catch {
    return '';
  }
}
