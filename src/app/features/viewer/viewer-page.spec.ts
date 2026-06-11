import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { GIT_PROVIDERS } from '../../core/git/git-provider';
import { GithubProvider } from '../../core/git/github/github-provider';
import { ViewerPage } from './viewer-page';

/**
 * Integration test of the full viewer pipeline: route → input binding →
 * store → provider (stubbed fetch) → rendered tree → file click → rendered
 * file content.
 */
describe('ViewerPage (integration)', () => {
  let harness: RouterTestingHarness;

  const fixtures: Record<string, unknown> = {
    '/repos/acme/rocket': {
      name: 'rocket',
      full_name: 'acme/rocket',
      description: 'a rocket',
      default_branch: 'main',
      html_url: 'https://github.com/acme/rocket',
      stargazers_count: 3,
      fork: false,
      owner: { login: 'acme' },
    },
    '/repos/acme/rocket/git/trees/main?recursive=1': {
      truncated: false,
      tree: [
        { path: 'src', type: 'tree', sha: 'tree1' },
        { path: 'src/engine.ts', type: 'blob', sha: 'blob1', size: 24 },
        { path: 'README.md', type: 'blob', sha: 'blob2', size: 14 },
      ],
    },
    '/repos/acme/rocket/git/blobs/blob2': {
      sha: 'blob2',
      size: 14,
      content: btoa('# Rocket\n\nGo!\n'),
      encoding: 'base64',
    },
    '/repos/acme/rocket/git/blobs/blob1': {
      sha: 'blob1',
      size: 24,
      content: btoa('export const thrust = 1;'),
      encoding: 'base64',
    },
  };

  beforeEach(async () => {
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const apiPath = url.replace('https://api.github.com', '');
        const body = fixtures[apiPath];
        if (!body) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter(
          [{ path: 'r/:owner/:repo', component: ViewerPage }],
          withComponentInputBinding(),
        ),
        { provide: GIT_PROVIDERS, useExisting: GithubProvider, multi: true },
      ],
    });
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function textOnScreen(): Promise<string> {
    await harness.fixture.whenStable();
    harness.detectChanges();
    return harness.routeNativeElement?.textContent ?? '';
  }

  it('loads a repo from the URL and renders the tree', async () => {
    await harness.navigateByUrl('/r/acme/rocket');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('acme/rocket');
      expect(text).toContain('README.md');
      expect(text).toContain('src');
      expect(text).toContain('2 files · 1 folders');
    });
  });

  it('opens a file when its tree row is clicked and renders the content', async () => {
    await harness.navigateByUrl('/r/acme/rocket');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('README.md');
    });

    const buttons = Array.from(
      harness.routeNativeElement!.querySelectorAll<HTMLButtonElement>('button'),
    );
    buttons.find((b) => b.textContent?.includes('README.md'))!.click();

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('# Rocket');
      expect(text).toContain('3 lines');
    });
  });

  it('deep-links straight to a nested file via the path query param', async () => {
    await harness.navigateByUrl('/r/acme/rocket?path=src%2Fengine.ts');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('export const thrust = 1;');
      // The tree revealed the parent dir of the deep-linked file.
      expect(text).toContain('engine.ts');
    });
  });

  it('shows a specific error screen when the repository does not exist', async () => {
    await harness.navigateByUrl('/r/acme/missing');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('Repository not found');
      expect(text).toContain('Try again');
    });
  });
});
