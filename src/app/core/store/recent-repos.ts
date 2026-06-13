import { Injectable, signal } from '@angular/core';

export interface RecentRepo {
  readonly owner: string;
  readonly repo: string;
  readonly description: string | null;
  /** Provider id; entries persisted before this field existed are github. */
  readonly provider?: string;
  /** Self-hosted instance origin (GitHub Enterprise, GitLab, Bitbucket Server). */
  readonly host?: string;
}

const STORAGE_KEY = 'time-tracer.recent-repos';
const MAX_ENTRIES = 6;

/** Remembers the last successfully opened repositories in localStorage. */
@Injectable({ providedIn: 'root' })
export class RecentRepos {
  private readonly _entries = signal<readonly RecentRepo[]>(load());
  readonly entries = this._entries.asReadonly();

  record(entry: RecentRepo): void {
    const next = [entry, ...this._entries().filter((e) => !sameRepo(e, entry))].slice(
      0,
      MAX_ENTRIES,
    );
    this._entries.set(next);
    persist(next);
  }

  remove(entry: RecentRepo): void {
    const next = this._entries().filter((e) => !sameRepo(e, entry));
    this._entries.set(next);
    persist(next);
  }
}

function sameRepo(a: RecentRepo, b: RecentRepo): boolean {
  return (
    (a.provider ?? 'github') === (b.provider ?? 'github') &&
    (a.host ?? '') === (b.host ?? '') &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

function load(): RecentRepo[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is RecentRepo =>
          !!e &&
          typeof e === 'object' &&
          typeof (e as RecentRepo).owner === 'string' &&
          typeof (e as RecentRepo).repo === 'string',
      )
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function persist(entries: readonly RecentRepo[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage may be unavailable (private mode, quota) — recents are best-effort.
  }
}
