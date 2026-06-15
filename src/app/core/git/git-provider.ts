import { InjectionToken, Injectable, inject } from '@angular/core';

import {
  CommitFileChange,
  CommitInfo,
  ParsedRepoUrl,
  RefResolution,
  RepoFile,
  RepoMetadata,
  RepoSlug,
  RepoTree,
  TreeEntry,
} from '../models';

/** Web links a provider can construct for a repo/ref/path (outbound UI links). */
export interface RepoWebLinks {
  readonly repoUrl: string;
  readonly fileUrl?: string;
  readonly rawFileUrl?: string;
}

/**
 * A git hosting provider the app can read public repositories from.
 *
 * All methods use unauthenticated APIs; errors are surfaced as
 * {@link RepoProviderError} so the UI can react per failure kind.
 */
export interface GitProvider {
  readonly id: string;
  readonly label: string;

  /** Whether this provider recognises the given user input. */
  canHandle(input: string): boolean;

  /** Parses user input into owner/repo (+ optional ref/path), or null. */
  parseUrl(input: string): ParsedRepoUrl | null;

  /**
   * Parses a repo reference on a self-hosted / custom instance at `host`
   * (GitHub Enterprise, self-hosted GitLab, Bitbucket Server). Accepts a full
   * URL on the host or a bare repo path; the result carries the host. Only
   * implemented by providers that support custom hosts.
   */
  parseHostedUrl?(input: string, host: string): ParsedRepoUrl | null;

  /**
   * Splits the combined `<ref>/<path>` tail of a tree/blob URL by matching it
   * against the repository's actual branches and tags, so refs containing `/`
   * (e.g. `feature/foo`) resolve correctly. Best-effort: resolves to null
   * (never rejects) when nothing matches or the lookup fails, in which case
   * callers keep their existing first-segment split.
   */
  resolveRefPath?(slug: RepoSlug, refAndPath: string): Promise<RefResolution | null>;

  getMetadata(slug: RepoSlug): Promise<RepoMetadata>;

  /** Full recursive tree at `ref` (branch, tag or commit sha). */
  getTree(slug: RepoSlug, ref: string): Promise<RepoTree>;

  /** Content of one tree entry; implementations apply a size guard. */
  getFile(slug: RepoSlug, entry: TreeEntry): Promise<RepoFile>;

  /**
   * Content of `path` as it was at `ref` (typically a historical commit sha).
   * Rejects with kind `not-found` when the path does not exist at that ref —
   * e.g. before the file was added or after the commit that deleted it.
   */
  getFileAtRef(slug: RepoSlug, path: string, ref: string): Promise<RepoFile>;

  /**
   * Commits reachable from `ref`, optionally limited to those touching `path`.
   * Primitive for the upcoming history/blame milestone.
   */
  listCommits(
    slug: RepoSlug,
    options?: { ref?: string; path?: string; perPage?: number; page?: number },
  ): Promise<CommitInfo[]>;

  /** A single commit by sha — used to resolve parents for diffs/blame. */
  getCommit(slug: RepoSlug, sha: string): Promise<CommitInfo>;

  /**
   * Optional bulk optimisation: precompute every path's commit history in one
   * pass, so a following burst of per-file {@link listCommits} calls is served
   * from cache. Implemented by providers backed by a full local object database
   * (the local folder reader), where asking per file would re-walk the whole
   * history each time. Networked providers omit it — they page over an API and
   * have nothing to precompute — so callers must treat it as best-effort.
   */
  primeHistories?(slug: RepoSlug, ref: string): Promise<void>;

  /**
   * Files touched by a commit, including provider-side rename detection
   * (`previousPath`). Powers the rename-candidate search where a file's
   * history ends.
   */
  getCommitFiles(slug: RepoSlug, sha: string): Promise<CommitFileChange[]>;

  /** Outbound web links, or null when the provider has no web pendant. */
  webLinks(slug: RepoSlug, ref: string, path?: string): RepoWebLinks | null;
}

/** All registered git providers (multi token). */
export const GIT_PROVIDERS = new InjectionToken<readonly GitProvider[]>('GIT_PROVIDERS');

/** Looks up providers by id or by sniffing user input. */
@Injectable({ providedIn: 'root' })
export class ProviderRegistry {
  private readonly providers = inject(GIT_PROVIDERS);

  byId(id: string): GitProvider {
    const provider = this.providers.find((p) => p.id === id);
    if (!provider) throw new Error(`Unknown git provider: ${id}`);
    return provider;
  }

  /** First provider that recognises the input, or null. */
  forInput(input: string): GitProvider | null {
    return this.providers.find((p) => p.canHandle(input)) ?? null;
  }
}
