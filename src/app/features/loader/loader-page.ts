import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { AccessTokens, TokenProviderId, hostKey } from '../../core/git/access-tokens';
import { GitProvider, ProviderRegistry } from '../../core/git/git-provider';
import { LocalRepos, supportsLocalRepos } from '../../core/git/local/local-repos';
import { ParsedRepoUrl } from '../../core/models';
import { RecentRepos, RecentRepo } from '../../core/store/recent-repos';

// Popular, heavily co-developed engineering projects — thousands of authors and
// rich history to explore (blame, diffs, line traces).
const EXAMPLES = [
  'timonkrebs/MemoizR',
  'microsoft/vscode',
  'kubernetes/kubernetes',
  'rust-lang/rust',
  'roc-lang/roc',
  'torvalds/linux',
];

/** Full commit shas need no ref/path disambiguation — they never contain `/`. */
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** Self-hostable provider flavors offered in the custom-instance form. */
const CUSTOM_FLAVORS = [
  { id: 'github', label: 'GitHub Enterprise' },
  { id: 'gitlab', label: 'GitLab (self-hosted)' },
  { id: 'bitbucket-server', label: 'Bitbucket Server / DC' },
] as const;

type CustomFlavor = (typeof CUSTOM_FLAVORS)[number]['id'];

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
            Explore any public GitHub, GitLab, Bitbucket or Azure DevOps repository — a self-hosted
            instance{{ localClause }} — and travel back through its history change by change, right
            in your browser.
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
            placeholder="github.com/owner/repo  ·  gitlab.com/…  ·  bitbucket.org/…  ·  dev.azure.com/…"
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

        <section class="mt-8">
          <button
            type="button"
            class="flex items-center gap-1.5 text-xs text-zinc-500 transition hover:text-zinc-300"
            (click)="tokensOpen.set(!tokensOpen())"
            [attr.aria-expanded]="tokensOpen()"
          >
            <svg
              class="size-3 transition-transform"
              [class.rotate-90]="tokensOpen()"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
            Personal access tokens
            @if (hasAnyToken()) {
              <span
                class="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-300"
                >set</span
              >
            }
          </button>
          @if (tokensOpen()) {
            <div class="mt-2 space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <p class="text-xs leading-5 text-zinc-500">
                Optional — raises API rate limits and unlocks private repositories. Tokens are
                stored only in this browser and sent only to the matching provider's API.
              </p>
              <div>
                <label class="mb-1 block text-xs font-medium text-zinc-400" for="github-token"
                  >GitHub</label
                >
                <input
                  id="github-token"
                  type="password"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="ghp_… or github_pat_…"
                  class="h-9 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-400/20"
                  [value]="tokens.tokenFor('github')"
                  (input)="saveToken('github', $event)"
                />
                <p class="mt-1 text-[11px] leading-4 text-zinc-600">
                  Raises the limit from 60 to 5,000 requests/hour; private repos need the
                  <span class="font-mono">repo</span> scope.
                  <a
                    class="text-indigo-300/80 transition hover:text-indigo-200 hover:underline"
                    href="https://github.com/settings/tokens"
                    target="_blank"
                    rel="noopener noreferrer"
                    >Create one ↗</a
                  >
                </p>
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-zinc-400" for="gitlab-token"
                  >GitLab</label
                >
                <input
                  id="gitlab-token"
                  type="password"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="glpat-…"
                  class="h-9 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-400/20"
                  [value]="tokens.tokenFor('gitlab')"
                  (input)="saveToken('gitlab', $event)"
                />
                <p class="mt-1 text-[11px] leading-4 text-zinc-600">
                  Unlocks private projects and raises limits; create one with the
                  <span class="font-mono">read_api</span> scope.
                  <a
                    class="text-indigo-300/80 transition hover:text-indigo-200 hover:underline"
                    href="https://gitlab.com/-/user_settings/personal_access_tokens"
                    target="_blank"
                    rel="noopener noreferrer"
                    >Create one ↗</a
                  >
                </p>
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-zinc-400" for="bitbucket-token"
                  >Bitbucket</label
                >
                <input
                  id="bitbucket-token"
                  type="password"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="access token, or user:app_password"
                  class="h-9 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-400/20"
                  [value]="tokens.tokenFor('bitbucket')"
                  (input)="saveToken('bitbucket', $event)"
                />
                <p class="mt-1 text-[11px] leading-4 text-zinc-600">
                  Unlocks private repositories — a repository/workspace access token (sent as
                  Bearer) or a <span class="font-mono">username:app_password</span> pair (sent as
                  Basic), needing <span class="font-mono">Repositories: Read</span>.
                </p>
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-zinc-400" for="azd-token"
                  >Azure DevOps</label
                >
                <input
                  id="azd-token"
                  type="password"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="Personal access token"
                  class="h-9 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-400/20"
                  [value]="tokens.tokenFor('azd')"
                  (input)="saveToken('azd', $event)"
                />
                <p class="mt-1 text-[11px] leading-4 text-zinc-600">
                  Unlocks private projects — create it with the
                  <span class="font-mono">Code (Read)</span> scope in your organization's user
                  settings.
                  <a
                    class="text-indigo-300/80 transition hover:text-indigo-200 hover:underline"
                    href="https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate"
                    target="_blank"
                    rel="noopener noreferrer"
                    >How ↗</a
                  >
                </p>
              </div>
            </div>
          }
        </section>

        <section class="mt-4">
          <button
            type="button"
            class="flex items-center gap-1.5 text-xs text-zinc-500 transition hover:text-zinc-300"
            (click)="customOpen.set(!customOpen())"
            [attr.aria-expanded]="customOpen()"
          >
            <svg
              class="size-3 transition-transform"
              [class.rotate-90]="customOpen()"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
            Self-hosted / custom instance
          </button>
          @if (customOpen()) {
            <div class="mt-2 space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <p class="text-xs leading-5 text-zinc-500">
                Connect to a GitHub Enterprise, self-hosted GitLab, or Bitbucket Server / Data
                Center instance by its base URL. The URL and token stay in this browser and go only
                to that instance's API.
              </p>
              <div
                class="flex gap-1 rounded-lg border border-zinc-700 p-0.5 text-[11px]"
                role="group"
                aria-label="Instance type"
              >
                @for (flavor of customFlavors; track flavor.id) {
                  <button
                    type="button"
                    class="flex-1 rounded px-2 py-1 transition"
                    [class]="
                      customFlavor() === flavor.id
                        ? 'bg-indigo-500/20 text-indigo-200'
                        : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                    "
                    (click)="customFlavor.set(flavor.id)"
                  >
                    {{ flavor.label }}
                  </button>
                }
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-zinc-400" for="custom-host"
                  >Instance base URL</label
                >
                <input
                  id="custom-host"
                  type="url"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="https://git.example.com"
                  class="h-9 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-400/20"
                  [value]="customHost()"
                  (input)="onCustomHostInput($event)"
                />
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-zinc-400" for="custom-repo"
                  >Repository</label
                >
                <input
                  id="custom-repo"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  [placeholder]="customRepoPlaceholder()"
                  class="h-9 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-400/20"
                  [value]="customRepo()"
                  (input)="onCustomRepoInput($event)"
                  (keydown.enter)="openCustom()"
                />
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-zinc-400" for="custom-token"
                  >Access token (optional)</label
                >
                <input
                  id="custom-token"
                  type="password"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="personal / HTTP access token"
                  class="h-9 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-400/20"
                  [disabled]="!customHost().trim()"
                  [value]="customTokenValue()"
                  (input)="saveCustomToken($event)"
                />
              </div>
              @if (customError()) {
                <p class="text-xs text-rose-400" role="alert">{{ customError() }}</p>
              }
              <button
                type="button"
                [disabled]="busy()"
                class="h-9 w-full rounded-lg bg-indigo-500 text-sm font-medium text-white transition hover:bg-indigo-400 focus-visible:ring-2 focus-visible:ring-indigo-300 active:bg-indigo-600 disabled:cursor-wait disabled:opacity-60"
                (click)="openCustom()"
              >
                {{ busy() ? 'Opening…' : 'Open instance repository' }}
              </button>
            </div>
          }
        </section>

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
                      @if (recent.host) {
                        <span class="text-[10px] text-zinc-600">{{ hostLabel(recent.host) }}</span>
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
          Client-only — data comes straight from the GitHub/GitLab/Bitbucket/Azure DevOps APIs (or
          your self-hosted instance){{ ownDiskClause }}. No server: repository content and access
          tokens never go anywhere else.
        </p>
      </div>
    </main>
  `,
})
export class LoaderPage {
  private readonly router = inject(Router);
  private readonly registry = inject(ProviderRegistry);
  private readonly localRepos = inject(LocalRepos);
  protected readonly recents = inject(RecentRepos);
  protected readonly tokens = inject(AccessTokens);

  protected readonly examples = EXAMPLES;
  protected readonly query = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly canOpenLocal = supportsLocalRepos();
  // Local-folder support needs the File System Access API; where it is missing
  // (e.g. Firefox, Safari) the folder button is hidden, so the copy that
  // advertises opening from disk is dropped too rather than promising it.
  protected readonly localClause = this.canOpenLocal ? ', or a local folder' : '';
  protected readonly ownDiskClause = this.canOpenLocal ? ' or your own disk' : '';
  protected readonly tokensOpen = signal(false);
  protected readonly hasAnyToken = computed(
    () =>
      !!(
        this.tokens.tokenFor('github') ||
        this.tokens.tokenFor('gitlab') ||
        this.tokens.tokenFor('bitbucket') ||
        this.tokens.tokenFor('azd')
      ),
  );

  // Self-hosted / custom-instance form.
  protected readonly customFlavors = CUSTOM_FLAVORS;
  protected readonly customOpen = signal(false);
  protected readonly customFlavor = signal<CustomFlavor>('github');
  protected readonly customHost = signal('');
  protected readonly customRepo = signal('');
  protected readonly customError = signal<string | null>(null);
  /** Token key the custom form reads/writes — the instance origin. */
  private readonly customTokenKey = computed(() => {
    const host = this.customHost().trim();
    return host ? hostKey(host) : '';
  });
  protected readonly customTokenValue = computed(() => {
    const key = this.customTokenKey();
    return key ? this.tokens.tokenFor(key) : '';
  });
  protected readonly customRepoPlaceholder = computed(() =>
    this.customFlavor() === 'bitbucket-server'
      ? 'PROJECT/repo or a browse URL'
      : 'owner/repo or a full URL',
  );

  protected onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.error.set(null);
  }

  /** Persists a token as it is typed; an emptied field clears it. */
  protected saveToken(provider: TokenProviderId, event: Event): void {
    this.tokens.setToken(provider, (event.target as HTMLInputElement).value);
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
        'That does not look like a hosted repository. Try "owner/repo", a full URL, or the self-hosted form below.',
      );
      return;
    }
    await this.navigateTo(provider, parsed);
  }

  /** Opens a repository on a self-hosted / custom instance. */
  protected async openCustom(): Promise<void> {
    if (this.busy()) return;
    const host = this.customHost().trim();
    if (!host) {
      this.customError.set('Enter the instance base URL.');
      return;
    }
    const repo = this.customRepo().trim();
    if (!repo) {
      this.customError.set('Enter the repository — owner/repo or a full URL on the instance.');
      return;
    }
    const provider = this.registry.byId(this.customFlavor());
    const parsed = provider.parseHostedUrl?.(repo, host) ?? null;
    if (!parsed) {
      this.customError.set('Could not read a repository from that input on this instance.');
      return;
    }
    this.customError.set(null);
    await this.navigateTo(provider, parsed);
  }

  /**
   * Resolves a parsed reference (disambiguating slash-containing refs against
   * the provider's real refs when it can) and navigates to the viewer, carrying
   * a custom instance `host` through the query string.
   */
  private async navigateTo(provider: GitProvider, parsed: ParsedRepoUrl): Promise<void> {
    const host = parsed.host;

    // The URL parser splits `tree/<ref>/<path>` at the first segment, which is
    // wrong for refs containing `/` (e.g. `feature/foo`). Let the provider
    // re-split against the repo's actual refs; on failure keep the naive split.
    let { ref, path } = parsed;
    if (ref && path && provider.resolveRefPath && !COMMIT_SHA_PATTERN.test(ref)) {
      this.busy.set(true);
      try {
        const resolved = await provider.resolveRefPath(
          {
            provider: provider.id,
            owner: parsed.owner,
            repo: parsed.repo,
            ...(host ? { host } : {}),
          },
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
    if (host) queryParams['host'] = host;
    if (ref) queryParams['ref'] = ref;
    if (path) queryParams['path'] = path;
    void this.router.navigate([routePrefix(provider.id), parsed.owner, parsed.repo], {
      queryParams,
    });
  }

  protected onCustomHostInput(event: Event): void {
    this.customHost.set((event.target as HTMLInputElement).value);
    this.customError.set(null);
  }

  protected onCustomRepoInput(event: Event): void {
    this.customRepo.set((event.target as HTMLInputElement).value);
    this.customError.set(null);
  }

  /** Persists the custom instance's token under its host key. */
  protected saveCustomToken(event: Event): void {
    const key = this.customTokenKey();
    if (key) this.tokens.setToken(key, (event.target as HTMLInputElement).value);
  }

  /** Hostname of an instance origin, for compact display. */
  protected hostLabel(host: string): string {
    try {
      return new URL(host).hostname;
    } catch {
      return host;
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
    void this.router.navigate([routePrefix(provider), recent.owner, recent.repo], {
      queryParams: recent.host ? { host: recent.host } : {},
    });
  }
}

function routePrefix(providerId: string): string {
  switch (providerId) {
    case 'gitlab':
      return '/gl';
    case 'azd':
      return '/azd';
    case 'bitbucket':
      return '/bb';
    case 'bitbucket-server':
      return '/bbs';
    default:
      return '/r';
  }
}
