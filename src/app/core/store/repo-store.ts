import { Injectable, computed, inject, signal } from '@angular/core';

import { ProviderRegistry, RepoWebLinks } from '../git/git-provider';
import {
  FileState,
  RepoLoadPhase,
  RepoMetadata,
  RepoProviderError,
  RepoSlug,
  TreeEntry,
  toRepoProviderError,
} from '../models';
import { ancestorsOf, buildTree } from '../util/tree';
import { RecentRepos } from './recent-repos';

/**
 * Single source of truth for the repository currently shown in the viewer:
 * load lifecycle, tree, expansion state, selection and per-file content cache.
 *
 * All async flows are guarded by a load sequence number so responses that
 * arrive after the user has already navigated elsewhere are dropped.
 */
@Injectable({ providedIn: 'root' })
export class RepoStore {
  private readonly registry = inject(ProviderRegistry);
  private readonly recents = inject(RecentRepos);

  private loadSeq = 0;

  private readonly _phase = signal<RepoLoadPhase>('idle');
  private readonly _error = signal<RepoProviderError | null>(null);
  private readonly _slug = signal<RepoSlug | null>(null);
  private readonly _requestedRef = signal<string | null>(null);
  private readonly _metadata = signal<RepoMetadata | null>(null);
  private readonly _entries = signal<readonly TreeEntry[]>([]);
  private readonly _truncated = signal(false);
  private readonly _selectedPath = signal<string | null>(null);
  private readonly _files = signal<ReadonlyMap<string, FileState>>(new Map());
  private readonly _expanded = signal<ReadonlySet<string>>(new Set());

  readonly phase = this._phase.asReadonly();
  readonly error = this._error.asReadonly();
  readonly slug = this._slug.asReadonly();
  readonly metadata = this._metadata.asReadonly();
  readonly truncated = this._truncated.asReadonly();
  readonly selectedPath = this._selectedPath.asReadonly();
  readonly expandedDirs = this._expanded.asReadonly();

  /** Ref shown in the viewer: the requested one, or the default branch. */
  readonly ref = computed(() => this._requestedRef() ?? this._metadata()?.defaultBranch ?? null);

  readonly tree = computed(() => buildTree(this._entries()));

  readonly fileCount = computed(() => this._entries().filter((e) => e.kind === 'file').length);
  readonly dirCount = computed(() => this._entries().filter((e) => e.kind === 'dir').length);

  private readonly entriesByPath = computed(() => {
    const map = new Map<string, TreeEntry>();
    for (const entry of this._entries()) map.set(entry.path, entry);
    return map;
  });

  /** State of the currently selected file, if any. */
  readonly selectedFile = computed<FileState | null>(() => {
    const path = this._selectedPath();
    return path ? (this._files().get(path) ?? null) : null;
  });

  /**
   * Loads a repository (metadata, then full tree). No-ops when the same
   * repo+ref is already loading or loaded, unless `force` is set.
   */
  async loadRepo(
    slug: RepoSlug,
    requestedRef?: string,
    options?: { force?: boolean },
  ): Promise<void> {
    const ref = requestedRef ?? null;
    if (!options?.force && this.isCurrentTarget(slug, ref) && this._phase() !== 'error') {
      return;
    }

    const seq = ++this.loadSeq;
    this._slug.set(slug);
    this._requestedRef.set(ref);
    this._metadata.set(null);
    this._entries.set([]);
    this._truncated.set(false);
    this._selectedPath.set(null);
    this._files.set(new Map());
    this._expanded.set(new Set());
    this._error.set(null);
    this._phase.set('metadata');

    try {
      const provider = this.registry.byId(slug.provider);
      const metadata = await provider.getMetadata(slug);
      if (seq !== this.loadSeq) return;
      this._metadata.set(metadata);
      this._phase.set('tree');

      const tree = await provider.getTree(slug, ref ?? metadata.defaultBranch);
      if (seq !== this.loadSeq) return;
      this._entries.set(tree.entries);
      this._truncated.set(tree.truncated);
      this._phase.set('ready');

      this.recents.record({
        owner: metadata.owner,
        repo: metadata.name,
        description: metadata.description,
      });
    } catch (error) {
      if (seq !== this.loadSeq) return;
      this._error.set(toRepoProviderError(error));
      this._phase.set('error');
    }
  }

  /** Re-runs the last requested load after an error. */
  retry(): void {
    const slug = this._slug();
    if (!slug) return;
    void this.loadRepo(slug, this._requestedRef() ?? undefined, { force: true });
  }

  /**
   * Selects a file, reveals it in the tree and fetches its content (cached
   * per path for the lifetime of the loaded snapshot).
   */
  async openFile(path: string): Promise<void> {
    this._selectedPath.set(path);
    this.revealPath(path);

    const existing = this._files().get(path);
    if (existing && existing.status !== 'error') return;

    const slug = this._slug();
    if (!slug) return;
    const entry = this.entriesByPath().get(path);
    if (!entry || entry.kind !== 'file') {
      this.setFileState(path, {
        status: 'error',
        path,
        message: 'This file does not exist at the current ref.',
      });
      return;
    }

    const seq = this.loadSeq;
    this.setFileState(path, { status: 'loading', path });
    try {
      const file = await this.registry.byId(slug.provider).getFile(slug, entry);
      if (seq !== this.loadSeq) return;
      this.setFileState(path, { status: 'ready', path, file });
    } catch (error) {
      if (seq !== this.loadSeq) return;
      this.setFileState(path, {
        status: 'error',
        path,
        message: toRepoProviderError(error).message,
      });
    }
  }

  clearSelection(): void {
    this._selectedPath.set(null);
  }

  toggleDir(path: string): void {
    const next = new Set(this._expanded());
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    this._expanded.set(next);
  }

  /** Expands all ancestor directories so `path` is visible in the tree. */
  revealPath(path: string): void {
    const ancestors = ancestorsOf(path);
    if (ancestors.every((a) => this._expanded().has(a))) return;
    this._expanded.set(new Set([...this._expanded(), ...ancestors]));
  }

  /** Outbound links for the loaded repo or one of its files. */
  linksFor(path?: string): RepoWebLinks | null {
    const slug = this._slug();
    const ref = this.ref();
    if (!slug || !ref) return null;
    return this.registry.byId(slug.provider).webLinks(slug, ref, path);
  }

  private isCurrentTarget(slug: RepoSlug, ref: string | null): boolean {
    const current = this._slug();
    return (
      !!current &&
      current.provider === slug.provider &&
      current.owner.toLowerCase() === slug.owner.toLowerCase() &&
      current.repo.toLowerCase() === slug.repo.toLowerCase() &&
      (this._requestedRef() ?? null) === ref
    );
  }

  private setFileState(path: string, state: FileState): void {
    const next = new Map(this._files());
    next.set(path, state);
    this._files.set(next);
  }
}
