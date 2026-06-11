/**
 * Domain models for Time Tracer.
 *
 * Everything is keyed by {@link RepoSlug} (which repository) plus a git ref
 * (which point in time). File contents are addressed by blob sha, so the same
 * blob seen at two different commits hits the same cache entry — this is the
 * foundation the upcoming history/blame features build on.
 */

/** Identifies a repository on a specific git hosting provider. */
export interface RepoSlug {
  /** Provider id, e.g. `github`. */
  readonly provider: string;
  readonly owner: string;
  readonly repo: string;
}

/** Result of parsing user input (URL, `owner/repo` shorthand, …). */
export interface ParsedRepoUrl {
  readonly owner: string;
  readonly repo: string;
  /** Branch, tag or commit sha if the input pointed at one. */
  readonly ref?: string;
  /** File or directory path if the input pointed at one. */
  readonly path?: string;
}

/** A `<ref>/<path>` split confirmed against the provider's actual refs. */
export interface RefResolution {
  readonly ref: string;
  /** Remaining path after the ref; absent when the ref consumed everything. */
  readonly path?: string;
}

/** Repository metadata as reported by the provider. */
export interface RepoMetadata {
  readonly owner: string;
  readonly name: string;
  /** `owner/name` */
  readonly fullName: string;
  readonly description: string | null;
  readonly defaultBranch: string;
  /** Web URL of the repository (for outbound links). */
  readonly htmlUrl: string;
  readonly starCount: number;
  readonly isFork: boolean;
}

export type TreeEntryKind = 'file' | 'dir' | 'submodule';

/** One flat entry of a repository tree at a given ref. */
export interface TreeEntry {
  /** Full path from the repository root, e.g. `src/app/main.ts`. */
  readonly path: string;
  /** Last path segment. */
  readonly name: string;
  readonly kind: TreeEntryKind;
  /** Object sha (blob sha for files). */
  readonly sha: string;
  /** Size in bytes; only present for files. */
  readonly size?: number;
}

/** Nested tree node derived from the flat entries; `children` only for dirs. */
export interface TreeNode extends TreeEntry {
  readonly children?: readonly TreeNode[];
}

/** A repository tree snapshot at one ref. */
export interface RepoTree {
  readonly entries: readonly TreeEntry[];
  /** True when the provider could not return the complete tree. */
  readonly truncated: boolean;
}

/** Decoded content of a single file. */
export type RepoFile =
  | {
      readonly kind: 'text';
      readonly path: string;
      readonly sha: string;
      readonly size: number;
      readonly text: string;
    }
  | {
      readonly kind: 'binary';
      readonly path: string;
      readonly sha: string;
      readonly size: number;
    }
  | {
      /** Files above the provider's/our size guard are not fetched. */
      readonly kind: 'too-large';
      readonly path: string;
      readonly sha: string;
      readonly size: number;
    };

/**
 * A single commit. Not yet surfaced in the UI; provider support exists so the
 * planned history/blame milestone can traverse a file's timeline.
 */
export interface CommitInfo {
  readonly sha: string;
  readonly message: string;
  /** First line of the message. */
  readonly summary: string;
  readonly authorName: string;
  readonly authorEmail: string | null;
  /** ISO 8601 author date. */
  readonly authoredAt: string;
  readonly htmlUrl: string;
  readonly parentShas: readonly string[];
}

/** One file touched by a commit, as reported by the provider. */
export interface CommitFileChange {
  readonly path: string;
  /** `added` | `removed` | `modified` | `renamed` | `copied` | … */
  readonly status: string;
  /** Previous path for renames/copies, when the provider detected one. */
  readonly previousPath?: string;
}

/** Categorised provider failures so the UI can react specifically. */
export type RepoErrorKind =
  | 'not-found'
  | 'rate-limited'
  | 'invalid-ref'
  | 'empty-repo'
  | 'network'
  | 'unknown';

export class RepoProviderError extends Error {
  constructor(
    message: string,
    readonly kind: RepoErrorKind,
    /** When a rate limit resets, if the provider told us. */
    readonly rateLimitResetAt?: Date,
  ) {
    super(message);
    this.name = 'RepoProviderError';
  }
}

/** Narrows unknown errors to a RepoProviderError, wrapping if necessary. */
export function toRepoProviderError(error: unknown): RepoProviderError {
  if (error instanceof RepoProviderError) return error;
  if (error instanceof TypeError) {
    return new RepoProviderError('Network error — check your connection and try again.', 'network');
  }
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return new RepoProviderError(message, 'unknown');
}

/** Loading lifecycle of the repository currently shown in the viewer. */
export type RepoLoadPhase = 'idle' | 'metadata' | 'tree' | 'ready' | 'error';

/** Async state of one opened file, keyed by path in the store. */
export type FileState =
  | { readonly status: 'loading'; readonly path: string }
  | { readonly status: 'ready'; readonly path: string; readonly file: RepoFile }
  | {
      readonly status: 'error';
      readonly path: string;
      readonly message: string;
      /** Error category, so callers can react (e.g. not-found ⇒ file absent). */
      readonly kind: RepoErrorKind;
    };
