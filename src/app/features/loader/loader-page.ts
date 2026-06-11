import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { ProviderRegistry } from '../../core/git/git-provider';
import { LocalRepos, supportsLocalRepos } from '../../core/git/local/local-repos';
import { ZipRepos } from '../../core/git/local/zip-repos';
import { RecentRepos, RecentRepo } from '../../core/store/recent-repos';

const EXAMPLES = ['angular/angular', 'sindresorhus/ky', 'octocat/Hello-World'];

/** Full commit shas need no ref/path disambiguation — they never contain `/`. */
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

@Component({
  selector: 'app-loader-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block h-full' },
  template: `
    <main class="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-6 py-16">
      <div class="w-full">
        <div class="mb-10 flex flex-col items-center text-center">
          <div
            class="mb-5 flex size-14 items-center justify-center rounded-2xl border border-indigo-400/30 bg-indigo-500/10 text-indigo-300"
          >
            <svg
              class="size-7"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <path d="M3 4v4h4" />
              <path d="M12 7v5l3.5 2" />
            </svg>
          </div>
          <h1 class="text-3xl font-semibold tracking-tight text-zinc-50">Time Tracer</h1>
          <p class="mt-2 max-w-md text-sm leading-6 text-zinc-400">
            Explore any public GitHub or GitLab repository — or a local folder — and travel back
            through its history change by change, right in your browser.
          </p>
        </div>

        <form (submit)="open($event)" class="flex gap-2" novalidate>
          <label class="sr-only" for="repo-input">Repository URL</label>
          <input
            id="repo-input"
            name="repo"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="github.com/owner/repo  ·  gitlab.com/…  ·  dev.azure.com/org/project/_git/repo"
            class="h-11 min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-4 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-400/20"
            [value]="query()"
            (input)="onInput($event)"
          />
          <button
            type="submit"
            [disabled]="busy()"
            class="h-11 shrink-0 rounded-lg bg-indigo-500 px-5 text-sm font-medium text-white transition hover:bg-indigo-400 focus-visible:ring-2 focus-visible:ring-indigo-300 active:bg-indigo-600 disabled:cursor-wait disabled:opacity-60"
          >
            {{ busy() ? 'Opening…' : 'Open' }}
          </button>
        </form>

        @if (error()) {
          <p class="mt-3 text-sm text-rose-400" role="alert">{{ error() }}</p>
        }

        @if (canOpenLocal) {
          <button
            type="button"
            [disabled]="busy()"
            class="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900/60 px-4 py-2.5 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-wait disabled:opacity-60"
            (click)="openLocal()"
          >
            <svg
              class="size-4 text-indigo-300/80"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path
                d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
              />
            </svg>
            Open a local repository folder…
          </button>
        }

        <button
          type="button"
          [disabled]="busy()"
          class="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900/60 px-4 py-2.5 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-wait disabled:opacity-60"
          (click)="zipInput.click()"
        >
          <svg
            class="size-4 text-indigo-300/80"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" />
          </svg>
          Open a repository .zip…
        </button>
        <input
          #zipInput
          type="file"
          accept=".zip,application/zip"
          class="hidden"
          (change)="openZip($event)"
        />

        <div class="mt-4 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span>Try:</span>
          @for (example of examples; track example) {
            <button
              type="button"
              class="rounded-full border border-zinc-700/80 px-3 py-1 font-mono text-[11px] text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
              (click)="openExample(example)"
            >
              {{ example }}
            </button>
          }
        </div>

        @if (recents.entries().length > 0) {
          <section class="mt-10">
            <h2 class="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">Recent</h2>
            <ul
              class="divide-y divide-zinc-800/80 rounded-xl border border-zinc-800 bg-zinc-900/40"
            >
              @for (recent of recents.entries(); track recent.owner + '/' + recent.repo) {
                <li class="group flex items-center">
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-4 py-3 text-left transition hover:bg-zinc-800/40"
                    (click)="openRecent(recent)"
                  >
                    <span class="flex items-center gap-2 font-mono text-sm text-zinc-200">
                      @if ((recent.provider ?? 'github') === 'local') {
                        {{ recent.repo }}
                      } @else {
                        {{ recent.owner }}/{{ recent.repo }}
                      }
                      @if (recent.provider && recent.provider !== 'github') {
                        <span
                          class="rounded-full border border-zinc-700 px-1.5 text-[10px] text-zinc-500"
                          >{{ recent.provider }}</span
                        >
                      }
                    </span>
                    @if (recent.description) {
                      <span class="w-full truncate text-xs text-zinc-500">{{
                        recent.description
                      }}</span>
                    }
                  </button>
                  <button
                    type="button"
                    class="mr-2 rounded p-1.5 text-zinc-600 opacity-0 transition group-hover:opacity-100 hover:bg-zinc-800 hover:text-zinc-300"
                    (click)="recents.remove(recent)"
                    aria-label="Remove from recent repositories"
                  >
                    <svg
                      class="size-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      aria-hidden="true"
                    >
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                </li>
              }
            </ul>
          </section>
        }

        <p class="mt-10 text-center text-xs leading-5 text-zinc-600">
          Client-only — data comes straight from the GitHub/GitLab public APIs (rate-limited when
          unauthenticated) or your own disk. No server, nothing leaves your browser.
        </p>
      </div>
    </main>
  `,
})
export class LoaderPage {
  private readonly router = inject(Router);
  private readonly registry = inject(ProviderRegistry);
  private readonly localRepos = inject(LocalRepos);
  private readonly zipRepos = inject(ZipRepos);
  protected readonly recents = inject(RecentRepos);

  protected readonly examples = EXAMPLES;
  protected readonly query = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly canOpenLocal = supportsLocalRepos();

  protected onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.error.set(null);
  }

  protected async open(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const input = this.query().trim();
    if (!input) {
      this.error.set('Paste a repository URL to get started.');
      return;
    }
    const provider = this.registry.forInput(input);
    const parsed = provider?.parseUrl(input);
    if (!provider || !parsed) {
      this.error.set(
        'That does not look like a GitHub or GitLab repository. Try "owner/repo" or a full URL.',
      );
      return;
    }

    // The URL parser splits `tree/<ref>/<path>` at the first segment, which is
    // wrong for refs containing `/` (e.g. `feature/foo`). Let the provider
    // re-split against the repo's actual refs; on failure keep the naive split.
    let { ref, path } = parsed;
    if (ref && path && provider.resolveRefPath && !COMMIT_SHA_PATTERN.test(ref)) {
      this.busy.set(true);
      try {
        const resolved = await provider.resolveRefPath(
          { provider: provider.id, owner: parsed.owner, repo: parsed.repo },
          `${ref}/${path}`,
        );
        if (resolved) ({ ref, path } = resolved);
      } catch {
        // Best-effort only — proceed with the naive split.
      } finally {
        this.busy.set(false);
      }
    }

    const queryParams: Record<string, string> = {};
    if (ref) queryParams['ref'] = ref;
    if (path) queryParams['path'] = path;
    void this.router.navigate([routePrefix(provider.id), parsed.owner, parsed.repo], {
      queryParams,
    });
  }

  /** Imports a repository from a .zip archive (works in every browser). */
  protected async openZip(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const name = await this.zipRepos.open(file);
      void this.router.navigate(['/local', name]);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not read the zip file.');
    } finally {
      this.busy.set(false);
    }
  }

  /** Opens a local folder via the File System Access API. */
  protected async openLocal(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const name = await this.localRepos.pick();
      if (name) void this.router.navigate(['/local', name]);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not open the folder.');
    } finally {
      this.busy.set(false);
    }
  }

  protected openExample(example: string): void {
    const [owner, repo] = example.split('/');
    void this.router.navigate(['/r', owner, repo]);
  }

  protected openRecent(recent: RecentRepo): void {
    const provider = recent.provider ?? 'github';
    if (provider === 'local') {
      void this.router.navigate(['/local', recent.repo]);
      return;
    }
    void this.router.navigate([routePrefix(provider), recent.owner, recent.repo]);
  }
}

function routePrefix(providerId: string): string {
  if (providerId === 'gitlab') return '/gl';
  if (providerId === 'azd') return '/azd';
  return '/r';
}
