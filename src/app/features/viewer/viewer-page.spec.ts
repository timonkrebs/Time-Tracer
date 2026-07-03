import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import git from 'isomorphic-git';

import { GIT_PROVIDERS } from '../../core/git/git-provider';
import { GithubProvider } from '../../core/git/github/github-provider';
import { LocalGitProvider } from '../../core/git/local/local-provider';
import { LocalRepos } from '../../core/git/local/local-repos';
import { createMemFs } from '../../core/git/local/mem-fs';
import { ViewerPage } from './viewer-page';

const NEW_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OLD_SHA = 'ffeeddccbbaa99887766554433221100ffeeddcc';
const RENAME_SHA = 'beadfeedbeadfeedbeadfeedbeadfeedbeadfeed';
const RUN_SHA = '1111111111111111111111111111111111111111';
const MIDDLE_SHA = '2222222222222222222222222222222222222222';
const ROOT_SHA = '3333333333333333333333333333333333333333';
const MOVE_EDIT_SHA = '4444444444444444444444444444444444444444';
const MOVE_SHA = '5555555555555555555555555555555555555555';
const MOVE_ROOT_SHA = '6666666666666666666666666666666666666666';
// src/gap.ts: rewritten by GAP_NEW, whose parent (GAP_GHOST) never touched the
// file and so is absent from its history — the case where the before side must
// still be annotated from the previous commit that did touch it (GAP_OLD).
const GAP_NEW_SHA = '7777777777777777777777777777777777777777';
const GAP_OLD_SHA = '8888888888888888888888888888888888888888';
const GAP_GHOST_SHA = '9999999999999999999999999999999999999999';

const NEW_COMMIT = {
  sha: NEW_SHA,
  html_url: `https://github.com/acme/rocket/commit/${NEW_SHA}`,
  commit: {
    message: 'docs: update readme\n\nExplain why the launch text changed.',
    author: { name: 'Ada', email: 'ada@example.com', date: '2026-06-01T00:00:00Z' },
  },
  parents: [{ sha: OLD_SHA }],
};

const OLD_COMMIT = {
  sha: OLD_SHA,
  html_url: `https://github.com/acme/rocket/commit/${OLD_SHA}`,
  commit: {
    message: 'docs: initial readme',
    author: { name: 'Grace', email: 'grace@example.com', date: '2026-01-01T00:00:00Z' },
  },
  parents: [],
};

const RENAME_COMMIT = {
  sha: RENAME_SHA,
  html_url: `https://github.com/acme/rocket/commit/${RENAME_SHA}`,
  commit: {
    message: 'refactor: rename thruster to engine',
    author: { name: 'Ada', email: 'ada@example.com', date: '2026-03-01T00:00:00Z' },
  },
  parents: [{ sha: OLD_SHA }],
};

const RUN_COMMIT = {
  sha: RUN_SHA,
  html_url: `https://github.com/acme/rocket/commit/${RUN_SHA}`,
  commit: {
    message: 'feat: update edge lines',
    author: { name: 'Ada', email: 'ada@example.com', date: '2026-07-01T00:00:00Z' },
  },
  parents: [{ sha: MIDDLE_SHA }],
};

const MIDDLE_COMMIT = {
  sha: MIDDLE_SHA,
  html_url: `https://github.com/acme/rocket/commit/${MIDDLE_SHA}`,
  commit: {
    message: 'chore: touch middle line',
    author: { name: 'Grace', email: 'grace@example.com', date: '2026-06-20T00:00:00Z' },
  },
  parents: [{ sha: ROOT_SHA }],
};

const ROOT_COMMIT = {
  sha: ROOT_SHA,
  html_url: `https://github.com/acme/rocket/commit/${ROOT_SHA}`,
  commit: {
    message: 'feat: add multi file',
    author: { name: 'Grace', email: 'grace@example.com', date: '2026-06-10T00:00:00Z' },
  },
  parents: [],
};

const MOVE_EDIT_COMMIT = {
  sha: MOVE_EDIT_SHA,
  html_url: `https://github.com/acme/rocket/commit/${MOVE_EDIT_SHA}`,
  commit: {
    message: 'fix: edit moved line',
    author: { name: 'Ada', email: 'ada@example.com', date: '2026-08-03T00:00:00Z' },
  },
  parents: [{ sha: MOVE_SHA }],
};

const MOVE_COMMIT = {
  sha: MOVE_SHA,
  html_url: `https://github.com/acme/rocket/commit/${MOVE_SHA}`,
  commit: {
    message: 'refactor: move line block',
    author: { name: 'Grace', email: 'grace@example.com', date: '2026-08-02T00:00:00Z' },
  },
  parents: [{ sha: MOVE_ROOT_SHA }],
};

const MOVE_ROOT_COMMIT = {
  sha: MOVE_ROOT_SHA,
  html_url: `https://github.com/acme/rocket/commit/${MOVE_ROOT_SHA}`,
  commit: {
    message: 'feat: add move fixture',
    author: { name: 'Grace', email: 'grace@example.com', date: '2026-08-01T00:00:00Z' },
  },
  parents: [],
};

const GAP_NEW_COMMIT = {
  sha: GAP_NEW_SHA,
  html_url: `https://github.com/acme/rocket/commit/${GAP_NEW_SHA}`,
  commit: {
    message: 'refactor: rewrite gap',
    author: { name: 'Ada', email: 'ada@example.com', date: '2026-09-09T00:00:00Z' },
  },
  // The parent is a commit that did not touch gap.ts, so it is absent below.
  parents: [{ sha: GAP_GHOST_SHA }],
};

const GAP_OLD_COMMIT = {
  sha: GAP_OLD_SHA,
  html_url: `https://github.com/acme/rocket/commit/${GAP_OLD_SHA}`,
  commit: {
    message: 'feat: add gap',
    author: { name: 'Grace', email: 'grace@example.com', date: '2026-02-02T00:00:00Z' },
  },
  parents: [],
};

// PAGED.md: a full page of history (30 commits) plus one older root commit, to
// exercise pagination ("Load all") and blame re-attribution as older commits
// arrive. Version at commit i has lines L0…L(30-i); each newer commit appends
// one line, so line 1 (L0) is born in the oldest commit — beyond page one.
const pagedSha = (i: number): string => `paged${String(i).padStart(35, '0')}`;
const PAGED_COMMITS = Array.from({ length: 31 }, (_, i) => ({
  sha: pagedSha(i),
  html_url: `https://github.com/acme/rocket/commit/${pagedSha(i)}`,
  commit: {
    message: `paged commit ${i}`,
    author:
      i === 30
        ? { name: 'Zoe', email: 'zoe@example.com', date: '2020-01-01T00:00:00Z' }
        : { name: 'Ada', email: 'ada@example.com', date: '2026-01-01T00:00:00Z' },
  },
  parents: i < 30 ? [{ sha: pagedSha(i + 1) }] : [],
}));
const pagedTextFor = (i: number): string =>
  Array.from({ length: 31 - i }, (_, k) => `L${k}`).join('\n') + '\n';

/**
 * Integration tests of the full viewer pipeline: route → input binding →
 * store → provider (stubbed fetch) → rendered tree/file/history DOM.
 */
describe('ViewerPage (integration)', () => {
  let harness: RouterTestingHarness;
  let router: Router;

  /**
   * Fixtures keyed by API pathname. Function values receive the full URL so
   * a fixture can vary by query params (e.g. contents at different refs).
   */
  const fixtures: Record<string, unknown | ((url: URL) => unknown)> = {
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
    '/repos/acme/rocket/git/trees/main': {
      truncated: false,
      tree: [
        { path: 'src', type: 'tree', sha: 'tree1' },
        { path: 'src/engine.ts', type: 'blob', sha: 'blob1', size: 24 },
        { path: 'src/multi.ts', type: 'blob', sha: 'blob-multi', size: 14 },
        { path: 'src/move.ts', type: 'blob', sha: 'blob-move', size: 18 },
        { path: 'README.md', type: 'blob', sha: 'blob2', size: 14 },
      ],
    },
    '/repos/acme/rocket/branches': [{ name: 'dev' }, { name: 'main' }],
    '/repos/acme/rocket/git/trees/dev': {
      truncated: false,
      tree: [{ path: 'DEV_NOTES.md', type: 'blob', sha: 'blob-dev', size: 9 }],
    },
    '/repos/acme/rocket/git/blobs/blob2': {
      sha: 'blob2',
      size: 17,
      content: btoa('# Rocket v0\n\nGo!\n'),
      encoding: 'base64',
    },
    '/repos/acme/rocket/git/blobs/blob1': {
      sha: 'blob1',
      size: 24,
      content: btoa('export const thrust = 1;'),
      encoding: 'base64',
    },
    '/repos/acme/rocket/git/blobs/blob-multi': {
      sha: 'blob-multi',
      size: 14,
      content: btoa('A\nb\nc\nd\ne\nf\nG\n'),
      encoding: 'base64',
    },
    '/repos/acme/rocket/git/blobs/blob-move': {
      sha: 'blob-move',
      size: 18,
      content: btoa('A\nC\nB changed\n'),
      encoding: 'base64',
    },
    // Per-path histories: engine.ts was created by a rename; thruster.ts is
    // its predecessor, last touched at the root commit.
    '/repos/acme/rocket/commits': (url: URL) => {
      const path = url.searchParams.get('path');
      const ref = url.searchParams.get('sha');
      if (path === 'src/engine.ts') return [RENAME_COMMIT];
      if (path === 'src/thruster.ts')
        return ref === OLD_SHA ? [OLD_COMMIT] : [RENAME_COMMIT, OLD_COMMIT];
      if (path === 'src/multi.ts') return [RUN_COMMIT, MIDDLE_COMMIT, ROOT_COMMIT];
      if (path === 'src/move.ts') return [MOVE_EDIT_COMMIT, MOVE_COMMIT, MOVE_ROOT_COMMIT];
      if (path === 'src/gap.ts') return [GAP_NEW_COMMIT, GAP_OLD_COMMIT];
      if (path === 'NOTES.md') return [OLD_COMMIT];
      if (path === 'PAGED.md') {
        const page = Number(url.searchParams.get('page') ?? '1');
        return PAGED_COMMITS.slice((page - 1) * 30, page * 30);
      }
      return [NEW_COMMIT, OLD_COMMIT];
    },
    '/repos/acme/rocket/contents/PAGED.md': (url: URL) => {
      const i = PAGED_COMMITS.findIndex((c) => c.sha === url.searchParams.get('ref'));
      if (i === -1) return undefined;
      const text = pagedTextFor(i);
      return {
        type: 'file',
        path: 'PAGED.md',
        sha: `blob-paged-${i}`,
        size: text.length,
        content: btoa(text),
        encoding: 'base64',
      };
    },
    '/repos/acme/rocket/contents/README.md': (url: URL) => {
      const ref = url.searchParams.get('ref');
      const text =
        ref === NEW_SHA ? '# Rocket v0\n\nGo!\n' : ref === OLD_SHA ? '# Rocket v0\n' : null;
      if (text === null) return undefined;
      return {
        type: 'file',
        path: 'README.md',
        sha: `blob-at-${ref}`,
        size: text.length,
        content: btoa(text),
        encoding: 'base64',
      };
    },
    '/repos/acme/rocket/contents/src/engine.ts': (url: URL) => {
      if (url.searchParams.get('ref') !== RENAME_SHA) return undefined;
      return {
        type: 'file',
        path: 'src/engine.ts',
        sha: 'blob1',
        size: 24,
        content: btoa('export const thrust = 1;'),
        encoding: 'base64',
      };
    },
    '/repos/acme/rocket/contents/src/thruster.ts': (url: URL) => {
      if (url.searchParams.get('ref') !== OLD_SHA) return undefined;
      return {
        type: 'file',
        path: 'src/thruster.ts',
        sha: 'blob0',
        size: 24,
        content: btoa('export const thrust = 0;'),
        encoding: 'base64',
      };
    },
    '/repos/acme/rocket/contents/src/multi.ts': (url: URL) => {
      const ref = url.searchParams.get('ref');
      const text =
        ref === RUN_SHA
          ? 'A\nb\nc\nd\ne\nf\nG\n'
          : ref === MIDDLE_SHA
            ? 'a\nb\nc\nd\ne\nf\ng\n'
            : ref === ROOT_SHA
              ? 'a\nb\nc\nD\ne\nf\ng\n'
              : null;
      if (text === null) return undefined;
      return {
        type: 'file',
        path: 'src/multi.ts',
        sha: `blob-multi-${ref}`,
        size: text.length,
        content: btoa(text),
        encoding: 'base64',
      };
    },
    '/repos/acme/rocket/contents/src/move.ts': (url: URL) => {
      const ref = url.searchParams.get('ref');
      const text =
        ref === MOVE_EDIT_SHA
          ? 'A\nC\nB changed\n'
          : ref === MOVE_SHA
            ? 'A\nC\nB\n'
            : ref === MOVE_ROOT_SHA
              ? 'A\nB\nC\n'
              : null;
      if (text === null) return undefined;
      return {
        type: 'file',
        path: 'src/move.ts',
        sha: `blob-move-${ref}`,
        size: text.length,
        content: btoa(text),
        encoding: 'base64',
      };
    },
    '/repos/acme/rocket/contents/src/gap.ts': (url: URL) => {
      const ref = url.searchParams.get('ref');
      // GAP_NEW rewrote the file; GAP_GHOST (its parent) kept GAP_OLD's content
      // since nothing touched gap.ts in between.
      const text =
        ref === GAP_NEW_SHA
          ? 'fresh1\nfresh2\n'
          : ref === GAP_GHOST_SHA || ref === GAP_OLD_SHA
            ? 'stale1\nstale2\n'
            : null;
      if (text === null) return undefined;
      return {
        type: 'file',
        path: 'src/gap.ts',
        sha: `blob-gap-${ref}`,
        size: text.length,
        content: btoa(text),
        encoding: 'base64',
      };
    },
    // The README change also deleted NOTES.md — the traced lines' source.
    [`/repos/acme/rocket/commits/${NEW_SHA}`]: {
      ...NEW_COMMIT,
      files: [
        { filename: 'README.md', status: 'modified' },
        { filename: 'NOTES.md', status: 'removed' },
      ],
    },
    [`/repos/acme/rocket/commits/${OLD_SHA}`]: OLD_COMMIT,
    [`/repos/acme/rocket/commits/${RUN_SHA}`]: RUN_COMMIT,
    [`/repos/acme/rocket/commits/${MIDDLE_SHA}`]: MIDDLE_COMMIT,
    [`/repos/acme/rocket/commits/${ROOT_SHA}`]: ROOT_COMMIT,
    [`/repos/acme/rocket/commits/${MOVE_EDIT_SHA}`]: MOVE_EDIT_COMMIT,
    [`/repos/acme/rocket/commits/${MOVE_SHA}`]: MOVE_COMMIT,
    [`/repos/acme/rocket/commits/${MOVE_ROOT_SHA}`]: MOVE_ROOT_COMMIT,
    [`/repos/acme/rocket/commits/${GAP_NEW_SHA}`]: {
      ...GAP_NEW_COMMIT,
      files: [{ filename: 'src/gap.ts', status: 'modified' }],
    },
    [`/repos/acme/rocket/commits/${GAP_OLD_SHA}`]: GAP_OLD_COMMIT,
    '/repos/acme/rocket/contents/NOTES.md': (url: URL) => {
      if (url.searchParams.get('ref') !== OLD_SHA) return undefined;
      return {
        type: 'file',
        path: 'NOTES.md',
        sha: 'blob-notes',
        size: 12,
        content: btoa('hello\n\nGo!\n'),
        encoding: 'base64',
      };
    },
    [`/repos/acme/rocket/commits/${RENAME_SHA}`]: {
      ...RENAME_COMMIT,
      files: [
        {
          filename: 'src/engine.ts',
          status: 'renamed',
          previous_filename: 'src/thruster.ts',
        },
      ],
    },
    // The world just before engine.ts appeared.
    [`/repos/acme/rocket/git/trees/${OLD_SHA}`]: {
      truncated: false,
      tree: [
        { path: 'src', type: 'tree', sha: 'tree0' },
        { path: 'src/thruster.ts', type: 'blob', sha: 'blob0', size: 24 },
        { path: 'README.md', type: 'blob', sha: 'blob2', size: 17 },
      ],
    },
  };

  beforeEach(async () => {
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const parsed = new URL(url);
        const fixture = fixtures[parsed.pathname];
        const body = typeof fixture === 'function' ? fixture(parsed) : fixture;
        if (!body) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter(
          [{ path: 'r/:owner/:repo', component: ViewerPage, data: { provider: 'github' } }],
          withComponentInputBinding(),
        ),
        { provide: GIT_PROVIDERS, useExisting: GithubProvider, multi: true },
      ],
    });
    harness = await RouterTestingHarness.create();
    router = TestBed.inject(Router);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function textOnScreen(): Promise<string> {
    await harness.fixture.whenStable();
    harness.detectChanges();
    return harness.routeNativeElement?.textContent ?? '';
  }

  function clickButton(includes: string): void {
    const buttons = Array.from(
      harness.routeNativeElement!.querySelectorAll<HTMLButtonElement>('button'),
    );
    const button = buttons.find((b) => (b.textContent ?? '').includes(includes));
    if (!button) throw new Error(`No button containing "${includes}" found`);
    button.click();
  }

  function press(key: string, opts: { meta?: boolean } = {}): void {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key, metaKey: opts.meta, bubbles: true, cancelable: true }),
    );
  }

  it('loads a repo from the URL and renders the tree', async () => {
    await harness.navigateByUrl('/r/acme/rocket');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('acme/rocket');
      expect(text).toContain('README.md');
      expect(text).toContain('src');
      expect(text).toContain('4 files · 1 folders');
    });
  });

  it('switches branches through the header selector', async () => {
    await harness.navigateByUrl('/r/acme/rocket');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('README.md');
    });

    // Open the branch selector; the list loads lazily on first open.
    harness.routeNativeElement!.querySelector<HTMLButtonElement>('[title="Switch branch"]')!.click();
    await vi.waitFor(async () => {
      const options = harness.routeNativeElement!.querySelectorAll('[role="option"]');
      expect(options.length).toBe(2);
      await textOnScreen();
    });

    // Pick "dev": the URL carries the ref and the tree reloads at that branch.
    const dev = Array.from(
      harness.routeNativeElement!.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ).find((b) => b.textContent?.includes('dev'))!;
    dev.click();
    await vi.waitFor(async () => {
      expect(router.url).toContain('ref=dev');
      const text = await textOnScreen();
      expect(text).toContain('DEV_NOTES.md');
      expect(text).not.toContain('README.md');
    });

    // Back to the default branch: the ref param is dropped (canonical URL) and
    // the cached branch list is reused — no second /branches request.
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const branchCalls = (): number =>
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('/branches')).length;
    expect(branchCalls()).toBe(1);
    harness.routeNativeElement!.querySelector<HTMLButtonElement>('[title="Switch branch"]')!.click();
    await vi.waitFor(async () => {
      await textOnScreen();
      expect(harness.routeNativeElement!.querySelectorAll('[role="option"]').length).toBe(2);
    });
    const main = Array.from(
      harness.routeNativeElement!.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ).find((b) => b.textContent?.includes('main'))!;
    main.click();
    await vi.waitFor(async () => {
      expect(router.url).not.toContain('ref=');
      expect(await textOnScreen()).toContain('README.md');
    });
    expect(branchCalls()).toBe(1);
  });

  it('collapses and restores the file tree', async () => {
    await harness.navigateByUrl('/r/acme/rocket');
    await vi.waitFor(async () => {
      await textOnScreen();
      expect(harness.routeNativeElement!.querySelector('app-file-tree')).not.toBeNull();
    });

    harness
      .routeNativeElement!.querySelector<HTMLButtonElement>('[aria-label="Hide file tree"]')!
      .click();
    await vi.waitFor(async () => {
      await textOnScreen();
      expect(harness.routeNativeElement!.querySelector('app-file-tree')).toBeNull();
    });

    harness
      .routeNativeElement!.querySelector<HTMLButtonElement>('[aria-label="Show file tree"]')!
      .click();
    await vi.waitFor(async () => {
      await textOnScreen();
      expect(harness.routeNativeElement!.querySelector('app-file-tree')).not.toBeNull();
    });
  });

  it('reveals the file tree on load even when it was previously collapsed', async () => {
    // A remembered collapse must not hide the tree when opening a repository —
    // the tree is how you start navigating a new codebase.
    localStorage.setItem('time-tracer.tree-collapsed', '1');
    await harness.navigateByUrl('/r/acme/rocket');

    await vi.waitFor(async () => {
      await textOnScreen();
      expect(harness.routeNativeElement!.querySelector('app-file-tree')).not.toBeNull();
    });
  });

  it('opens a file when its tree row is clicked and renders the content', async () => {
    await harness.navigateByUrl('/r/acme/rocket');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('README.md');
    });

    clickButton('README.md');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('# Rocket');
      expect(text).toContain('3 lines');
    });
  });

  it('badges an opened file with its change-heat metric', async () => {
    await harness.navigateByUrl('/r/acme/rocket?path=README.md');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('# Rocket');
    });

    // README.md has two commits by two authors; opening it loads that history,
    // which the store turns into a hotspot badge on the tree row.
    await vi.waitFor(async () => {
      await textOnScreen();
      const badge = harness.routeNativeElement!.querySelector<HTMLElement>(
        'app-file-tree .heat-badge',
      );
      expect(badge).not.toBeNull();
      const label = badge!.getAttribute('aria-label') ?? '';
      expect(label).toContain('2 changes');
      expect(label).toContain('2 authors');
      expect(badge!.textContent!.trim()).not.toBe('');
    });
  });

  it('deep-links straight to a nested file via the path query param', async () => {
    await harness.navigateByUrl('/r/acme/rocket?path=src%2Fengine.ts');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('export const thrust = 1;');
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

  it('lets you explore the loaded tree when a same-repo reload is blocked', async () => {
    // First load succeeds — the tree is on screen.
    await harness.navigateByUrl('/r/acme/rocket');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('README.md');
    });

    // Switching to a ref the provider can't serve fails the reload (its tree
    // 404s), but the tree already loaded for the default ref survives, so the
    // error screen offers to explore it instead of dead-ending.
    await harness.navigateByUrl('/r/acme/rocket?ref=blocked');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('Explore anyway');
    });

    clickButton('Explore anyway');
    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('not fully loaded'); // the warning pill
      expect(text).toContain('README.md'); // the tree is back and explorable
    });
  });

  it('shows the commit history and travels to an old version and back', async () => {
    await harness.navigateByUrl('/r/acme/rocket?path=README.md');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('# Rocket');
    });

    clickButton('History');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('docs: update readme');
      expect(text).toContain('docs: initial readme');
      expect(text).toContain('Current version');
    });

    clickButton('docs: initial readme');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('# Rocket v0');
      expect(text).toContain('Viewing at');
      expect(text).toContain(OLD_SHA.slice(0, 7));
    });
    expect(router.url).toContain(`at=${OLD_SHA}`);

    clickButton('Back to main');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).not.toContain('Viewing at');
      expect(text).toContain('# Rocket');
    });
    expect(router.url).not.toContain('at=');
  });

  it('deep-links to a historical version and auto-opens the history panel', async () => {
    await harness.navigateByUrl(`/r/acme/rocket?path=README.md&at=${OLD_SHA}`);

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('# Rocket v0');
      expect(text).toContain('Viewing at');
      // Panel auto-opened and resolved the commit metadata.
      expect(text).toContain('docs: initial readme');
      expect(text).toContain('Grace');
    });
  });

  it('steps between commits with the older/newer controls', async () => {
    await harness.navigateByUrl(`/r/acme/rocket?path=README.md&at=${NEW_SHA}`);
    // The steppers need the loaded history to know their neighbours.
    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('Viewing at');
      expect(text).toContain('docs: initial readme');
    });

    clickButton('Older');
    await vi.waitFor(async () => {
      expect(router.url).toContain(`at=${OLD_SHA}`);
    });

    clickButton('Newer');
    await vi.waitFor(async () => {
      expect(router.url).toContain(`at=${NEW_SHA}`);
    });
  });

  it('clears time travel when selecting a different file', async () => {
    await harness.navigateByUrl(`/r/acme/rocket?path=README.md&at=${OLD_SHA}`);
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('# Rocket v0');
    });

    clickButton('src'); // expand the directory first
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('engine.ts');
    });
    clickButton('engine.ts');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('export const thrust = 1;');
      expect(text).not.toContain('Viewing at');
    });
    expect(router.url).not.toContain('at=');
  });

  it('shows what a commit changed and switches back to the file view', async () => {
    await harness.navigateByUrl(`/r/acme/rocket?path=README.md&at=${NEW_SHA}`);
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('Viewing at');
    });

    clickButton('Changes');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('@@ -1,1 +1,3 @@');
      // Removed old line and added new line are both visible.
      expect(text).toContain('# Rocket v0');
      expect(text).toContain('Go!');
      expect(text).toContain(`vs ${OLD_SHA.slice(0, 7)}`);
    });
    expect(router.url).toContain('view=diff');

    clickButton('File');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).not.toContain('@@');
      expect(text).toContain('Go!');
    });
    expect(router.url).not.toContain('view=diff');
  });

  it('deep-links to a root-commit diff and reports everything as new', async () => {
    await harness.navigateByUrl(`/r/acme/rocket?path=README.md&at=${OLD_SHA}&view=diff`);

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('initial commit — everything is new');
      expect(text).toContain('# Rocket v0');
      expect(text).toContain('@@ -0,0 +1,1 @@');
    });
  });

  it('opens the changes view by default when picking a commit', async () => {
    await harness.navigateByUrl('/r/acme/rocket?path=README.md');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('Go!');
    });

    clickButton('History');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('docs: update readme');
    });
    clickButton('docs: update readme');

    await vi.waitFor(async () => {
      expect(router.url).toContain('view=diff');
      expect(await textOnScreen()).toContain('@@ -1,1 +1,3 @@');
    });
  });

  it('remembers switching back to the file view for later commit picks', async () => {
    await harness.navigateByUrl(`/r/acme/rocket?path=README.md&at=${NEW_SHA}`);
    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('Viewing at');
      expect(text).toContain('docs: initial readme'); // history loaded
    });

    clickButton('File');
    await vi.waitFor(async () => {
      expect(router.url).toContain('view=file');
    });
    expect(localStorage.getItem('time-tracer.view-mode')).toBe('file');

    clickButton('docs: initial readme');

    await vi.waitFor(async () => {
      expect(router.url).toContain(`at=${OLD_SHA}`);
      expect(router.url).toContain('view=file');
      const text = await textOnScreen();
      expect(text).toContain('# Rocket v0');
      expect(text).not.toContain('@@');
    });
  });

  it('shows the steppers at the tip and steps into the newest commit', async () => {
    await harness.navigateByUrl('/r/acme/rocket?path=README.md');
    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('Current version');
      expect(text).toContain('Go!');
    });

    const buttons = Array.from(
      harness.routeNativeElement!.querySelectorAll<HTMLButtonElement>('button'),
    );
    const newer = buttons.find((b) => (b.textContent ?? '').includes('Newer'))!;
    const older = buttons.find((b) => (b.textContent ?? '').includes('Older'))!;
    expect(newer.disabled).toBe(true);
    expect(older.disabled).toBe(false);

    older.click();

    await vi.waitFor(async () => {
      expect(router.url).toContain(`at=${NEW_SHA}`);
      expect(await textOnScreen()).toContain('Viewing at');
    });
  });

  it('annotates lines with blame and jumps to the introducing commit', async () => {
    await harness.navigateByUrl('/r/acme/rocket?path=README.md');

    await vi.waitFor(async () => {
      expect(router.url).not.toContain('blame=0');
      const text = await textOnScreen();
      expect(text).toContain('01.01.2026 Grace'); // line 1: introduced by the root commit
      expect(text).toContain('01.06.2026 Ada'); // lines 2-3: introduced by the newest commit
    });
    const adaBlame = Array.from(
      harness.routeNativeElement!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => (button.textContent ?? '').includes('01.06.2026 Ada'));
    expect(adaBlame?.title).toContain('Explain why the launch text changed.');

    clickButton('01.01.2026 Grace');

    await vi.waitFor(async () => {
      expect(router.url).toContain(`at=${OLD_SHA}`);
      expect(router.url).toContain('view=diff');
      // The jump targets the line's position at the introducing commit.
      expect(router.url).toContain('line=1');
      expect(await textOnScreen()).toContain('initial commit — everything is new');
    });
  });

  it('loads all older history and re-attributes blame beyond the loaded pages', async () => {
    // PAGED.md starts with one page of history, so its oldest line (born in the
    // still-unloaded root commit) cannot be attributed yet.
    await harness.navigateByUrl(`/r/acme/rocket?path=PAGED.md&at=${pagedSha(0)}&view=file`);

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('Some lines predate the loaded history'); // blame is truncated
      expect(text).toContain('Load all'); // pagination control (history auto-opened)
    });
    expect(await textOnScreen()).not.toContain('01.01.2020 Zoe'); // root not attributed yet

    clickButton('Load all');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      // The whole history is now loaded: the notice clears and the oldest line
      // is attributed to the root commit — i.e. the annotations updated.
      expect(text).not.toContain('Some lines predate the loaded history');
      expect(text).toContain('01.01.2020 Zoe');
    });
  });

  it('toggles the Owners panel, persists it, and folds blame even with blame display off', async () => {
    await harness.navigateByUrl('/r/acme/rocket?path=README.md&blame=0');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('# Rocket'); // file renders, blame gutter off
    });

    clickButton('Owners');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('Ownership'); // panel is open
      // Authorship folded from blame, which the panel forces on despite blame=0.
      expect(text).toContain('Bus factor');
      expect(text).toContain('Ada');
    });
    expect(localStorage.getItem('time-tracer.owners-open')).toBe('1');

    clickButton('Owners');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).not.toContain('Ownership');
    });
    expect(localStorage.getItem('time-tracer.owners-open')).toBe('0');
  });

  it('keeps the folder scan opt-in for a networked provider', async () => {
    await harness.navigateByUrl('/r/acme/rocket?path=README.md');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('# Rocket');
    });

    clickButton('Owners');
    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('Ownership');
      // GitHub reads over a paged API, so the request-heavy folder chart stays
      // behind the button rather than scanning automatically.
      expect(text).toContain('Scan this folder');
    });
  });

  it('drives the panels and blame from the keyboard', async () => {
    await harness.navigateByUrl('/r/acme/rocket?path=README.md');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('# Rocket');
    });

    press('h'); // open history
    await vi.waitFor(() =>
      expect(harness.routeNativeElement!.querySelector('app-file-history')).not.toBeNull(),
    );
    expect(localStorage.getItem('time-tracer.history-open')).toBe('1');

    press('o'); // open owners
    await vi.waitFor(() =>
      expect(harness.routeNativeElement!.querySelector('app-ownership-panel')).not.toBeNull(),
    );

    press('Escape'); // close the side panels
    await vi.waitFor(() => {
      expect(harness.routeNativeElement!.querySelector('app-file-history')).toBeNull();
      expect(harness.routeNativeElement!.querySelector('app-ownership-panel')).toBeNull();
    });

    press('t'); // collapse the tree
    await vi.waitFor(() =>
      expect(harness.routeNativeElement!.querySelector('app-file-tree')).toBeNull(),
    );

    press('b'); // blame off
    await vi.waitFor(() => expect(router.url).toContain('blame=0'));
  });

  it('steps commits with the arrow keys', async () => {
    await harness.navigateByUrl('/r/acme/rocket?path=README.md');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('# Rocket');
    });

    press('ArrowLeft'); // ← Older from the tip → the newest commit
    await vi.waitFor(() => expect(router.url).toContain(`at=${NEW_SHA}`));

    press('ArrowRight'); // → Newer → back to the tip
    await vi.waitFor(() => expect(router.url).not.toContain('at='));
  });

  it('does not fire shortcuts while the finder overlay is open', async () => {
    await harness.navigateByUrl('/r/acme/rocket?path=README.md');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('# Rocket');
    });

    press('p', { meta: true }); // open the finder
    await vi.waitFor(() =>
      expect(harness.routeNativeElement!.querySelector('app-file-finder')).not.toBeNull(),
    );

    press('t'); // would collapse the tree, but the finder owns the keyboard
    await textOnScreen();
    expect(harness.routeNativeElement!.querySelector('app-file-tree')).not.toBeNull();
    expect(harness.routeNativeElement!.querySelector('app-file-finder')).not.toBeNull();
  });

  it('splits the changes view with blame on both sides', async () => {
    await harness.navigateByUrl(`/r/acme/rocket?path=README.md&at=${NEW_SHA}&view=diff`);

    await vi.waitFor(async () => {
      expect(router.url).not.toContain('blame=0');
      const text = await textOnScreen();
      // Split header: parent on the left, the commit on the right.
      expect(text).toContain('Before');
      expect(text).toContain('After');
      expect(text).toContain(OLD_SHA.slice(0, 7));
      expect(text).toContain(NEW_SHA.slice(0, 7));
      // Both sides carry annotations: the parent version is all Grace's,
      // the commit's version adds Ada's lines.
      expect(text).toContain('01.01.2026 Grace');
      expect(text).toContain('01.06.2026 Ada');
      // Content of both sides, aligned: the surviving line and the addition.
      expect(text).toContain('# Rocket v0');
      expect(text).toContain('Go!');
    });

    // Clicking an annotation still travels, targeting the line at the
    // introducing commit — Ada's first block starts at line 2 of NEW.
    clickButton('01.06.2026 Ada');
    await vi.waitFor(async () => {
      expect(router.url).toContain(`at=${NEW_SHA}`);
      expect(router.url).toContain('line=2');
    });

    // Turning blame off returns to the unified diff.
    clickButton('Blame');
    await vi.waitFor(async () => {
      expect(router.url).toContain('blame=0');
      expect(await textOnScreen()).toContain('@@ -1,1 +1,3 @@');
    });
  });

  it('annotates the before side when the parent is absent from the file history', async () => {
    // gap.ts was rewritten by GAP_NEW, whose parent (GAP_GHOST) never touched
    // the file and so is not in its history. The before side must still be
    // annotated — anchored on the previous commit that did touch it (GAP_OLD) —
    // so its (deleted) old lines stay navigable.
    await harness.navigateByUrl(`/r/acme/rocket?path=src/gap.ts&at=${GAP_NEW_SHA}&view=diff`);

    await vi.waitFor(async () => {
      expect(router.url).not.toContain('blame=0');
      await textOnScreen();
      const diff = harness.routeNativeElement!.querySelector('app-diff-view');
      expect(diff).not.toBeNull();
      const diffText = diff!.textContent ?? '';
      expect(diffText).toContain('Before');
      expect(diffText).toContain('After');
      // The whole file was rewritten, so the old lines survive only on the
      // before side. Grace's annotation appears there despite the parent commit
      // being absent from gap.ts's history; the new lines are Ada's.
      expect(diffText).toContain('02.02.2026 Grace');
      expect(diffText).toContain('09.09.2026 Ada');
    });

    // The before-side annotation is a real, navigable blame button.
    const before = Array.from(
      harness
        .routeNativeElement!.querySelector('app-diff-view')!
        .querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => (b.textContent ?? '').includes('02.02.2026 Grace'));
    expect(before).toBeTruthy();
  });

  it('reopens the history panel from the changes view at a historic commit', async () => {
    await harness.navigateByUrl(`/r/acme/rocket?path=README.md&at=${NEW_SHA}&view=diff`);
    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('@@ -1,1 +1,3 @@');
      expect(text).toContain('docs: initial readme'); // panel auto-opened
    });

    // Close the panel, then reopen it from the diff header's History toggle.
    harness
      .routeNativeElement!.querySelector<HTMLButtonElement>('[aria-label="Close history panel"]')!
      .click();
    await vi.waitFor(async () => {
      expect(await textOnScreen()).not.toContain('docs: initial readme');
    });

    clickButton('History');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('docs: initial readme');
    });
  });

  it('steps before a hunk into the annotated parent version', async () => {
    await harness.navigateByUrl(`/r/acme/rocket?path=README.md&at=${NEW_SHA}&view=diff`);
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('@@ -1,1 +1,3 @@');
    });

    clickButton('◂ Before');

    await vi.waitFor(async () => {
      expect(router.url).toContain(`at=${OLD_SHA}`);
      expect(router.url).toContain('view=file');
      expect(router.url).toContain('blame=1');
      expect(router.url).toContain('line=1');
      const text = await textOnScreen();
      expect(text).toContain('# Rocket v0');
      expect(text).toContain('01.01.2026 Grace'); // blame gutter of the parent version
    });
  });

  it('traces a hunk to only the commits that changed its lines', async () => {
    await harness.navigateByUrl(`/r/acme/rocket?path=README.md&at=${NEW_SHA}&view=diff`);
    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('@@ -1,1 +1,3 @@');
      expect(text).toContain('docs: initial readme'); // full history in the panel
    });

    clickButton('Trace');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      // The hunk added lines 2–3; only the commit that introduced them stays.
      expect(text).toContain('Tracing lines 2–3');
      expect(text).toContain('docs: update readme');
      expect(text).not.toContain('docs: initial readme');
      expect(text).toContain('The oldest commit above introduced these lines.');
    });

    harness
      .routeNativeElement!.querySelector<HTMLButtonElement>('[aria-label="Stop tracing"]')!
      .click();

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).not.toContain('Tracing lines');
      expect(text).toContain('docs: initial readme'); // full history is back
    });
  });

  it('traces a single change run inside a merged display hunk', async () => {
    await harness.navigateByUrl(
      `/r/acme/rocket?path=src%2Fmulti.ts&at=${RUN_SHA}&view=diff&blame=0`,
    );
    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('@@ -1,7 +1,7 @@');
      expect(text).toContain('chore: touch middle line'); // full history in the panel
    });

    clickButton('Trace');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('Tracing line 1');
      expect(text).toContain('feat: update edge lines');
      expect(text).not.toContain('chore: touch middle line');
    });
  });

  it('traces a manually selected line range', async () => {
    await harness.navigateByUrl(
      `/r/acme/rocket?path=src%2Fmulti.ts&at=${RUN_SHA}&view=diff&blame=0`,
    );
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('@@ -1,7 +1,7 @@');
    });

    harness
      .routeNativeElement!.querySelector<HTMLButtonElement>('[aria-label="Select line 1"]')!
      .click();
    harness
      .routeNativeElement!.querySelector<HTMLButtonElement>('[aria-label="Select line 7"]')!
      .click();
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('lines 1–7');
    });

    clickButton('Trace selection');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('Tracing lines 1–7');
      expect(text).toContain('feat: update edge lines');
      expect(text).toContain('chore: touch middle line');
    });
  });

  it('traces a range selected in the current version blame gutter', async () => {
    // The most valuable case: start a trace straight from the file you are
    // reading. With no commit selected, the range anchors at the most recent
    // commit that touched the file (its line numbers match the tip).
    await harness.navigateByUrl('/r/acme/rocket?path=src%2Fmulti.ts');
    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('Current version');
      expect(
        harness.routeNativeElement!.querySelector('[aria-label="Select line 1"]'),
      ).not.toBeNull();
    });

    harness
      .routeNativeElement!.querySelector<HTMLButtonElement>('[aria-label="Select line 1"]')!
      .click();
    harness
      .routeNativeElement!.querySelector<HTMLButtonElement>('[aria-label="Select line 7"]')!
      .click();
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('lines 1–7');
    });

    clickButton('Trace selection');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('Tracing lines 1–7');
      expect(text).toContain('feat: update edge lines');
      expect(text).toContain('chore: touch middle line');
    });
  });

  it('highlights a deep-linked line range with no active trace', async () => {
    // The range lives in the URL (`line=1-7`), so a shared link or reload
    // highlights the whole span — not just its first line — without a trace.
    await harness.navigateByUrl(
      `/r/acme/rocket?path=src%2Fmulti.ts&at=${RUN_SHA}&view=diff&blame=0&line=1-7`,
    );
    await vi.waitFor(() => {
      const highlighted = harness.routeNativeElement!.querySelectorAll('.trace-highlight-row');
      expect(highlighted.length).toBeGreaterThan(1);
    });
  });

  it('traces moved lines and highlights their range in filtered commits', async () => {
    await harness.navigateByUrl(
      `/r/acme/rocket?path=src%2Fmove.ts&at=${MOVE_EDIT_SHA}&view=diff&blame=0`,
    );
    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('@@ -1,3 +1,3 @@');
      expect(text).toContain('fix: edit moved line');
    });

    clickButton('Trace');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('Tracing line 3');
      expect(text).toContain('fix: edit moved line');
      expect(text).toContain('refactor: move line block');
      expect(text).toContain('feat: add move fixture');
    });

    clickButton('refactor: move line block');

    await vi.waitFor(async () => {
      expect(router.url).toContain(`at=${MOVE_SHA}`);
      expect(router.url).toContain('line=3');
      const highlighted = Array.from(
        harness.routeNativeElement!.querySelectorAll<HTMLElement>('.trace-highlight-row'),
      );
      expect(highlighted.some((row) => (row.textContent ?? '').includes('B'))).toBe(true);
    });

    clickButton('feat: add move fixture');

    await vi.waitFor(async () => {
      expect(router.url).toContain(`at=${MOVE_ROOT_SHA}`);
      expect(router.url).toContain('line=2');
      const highlighted = Array.from(
        harness.routeNativeElement!.querySelectorAll<HTMLElement>('.trace-highlight-row'),
      );
      expect(highlighted.some((row) => (row.textContent ?? '').includes('B'))).toBe(true);
    });
  });

  it('searches where traced lines came from and jumps to the source', async () => {
    await harness.navigateByUrl(`/r/acme/rocket?path=README.md&at=${NEW_SHA}&view=diff`);
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('@@ -1,1 +1,3 @@');
    });

    clickButton('Trace');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('The oldest commit above introduced these lines.');
    });

    clickButton('Where did these lines come from?');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      // NOTES.md was deleted by the same commit and contains the block.
      expect(text).toContain('NOTES.md');
      expect(text).toContain('100% match');
      expect(text).toContain('line 2');
      expect(text).toContain('of file'); // whole-file similarity, for "where from"
      expect(text).toContain('deleted');
    });

    clickButton('NOTES.md');

    await vi.waitFor(async () => {
      expect(router.url).toContain('path=NOTES.md');
      expect(router.url).toContain(`at=${OLD_SHA}`);
      expect(router.url).toContain('line=2');
      // The source file renders at its pre-deletion version.
      expect(await textOnScreen()).toContain('hello');
    });
  });

  it('diffs the introduced lines against an origin candidate', async () => {
    await harness.navigateByUrl(`/r/acme/rocket?path=README.md&at=${NEW_SHA}&view=diff`);
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('@@ -1,1 +1,3 @@');
    });

    clickButton('Trace');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('The oldest commit above introduced these lines.');
    });

    clickButton('Where did these lines come from?');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('NOTES.md');
    });

    clickButton('Diff'); // the per-candidate "Diff against this source" action

    await vi.waitFor(async () => {
      // The traced file at the introducing commit, compared against the source:
      // the lines they share (the moved block) line up while the rest is +/−.
      expect(router.url).toContain(`at=${NEW_SHA}`);
      expect(router.url).toContain('base=NOTES.md');
      expect(router.url).toContain('view=diff');
      expect(router.url).toContain('line=2-3');
      const text = await textOnScreen();
      expect(text).toContain('vs NOTES.md'); // header names the compared source
      expect(text).toContain('hello'); // the source's differing line, on the before side
    });
  });

  it('shows a file introduced by a rename as added, with the predecessor offered in history', async () => {
    // The oldest commit of a path's recorded history reads as the file's
    // creation: it is shown as added, not diffed against the file it was
    // renamed from, which the history offers via "Continue past the rename?"
    // instead (issue #8).
    await harness.navigateByUrl(`/r/acme/rocket?path=src%2Fengine.ts&at=${RENAME_SHA}&view=diff`);
    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('export const thrust = 1;'); // the introduced file
      expect(text).toContain('nothing at parent'); // no previous version under this path
      expect(text).toContain('refactor: rename thruster to engine'); // history loaded
      expect(text).toContain('Continue past the rename?'); // the explicit way across
    });
    const text = await textOnScreen();
    // The rename is not pre-empted in the diff: no predecessor content, no step before.
    expect(text).not.toContain('export const thrust = 0;');
    expect(text).not.toContain('◂ Before');

    await vi.waitFor(async () => {
      const annotated = await textOnScreen();
      expect(annotated).toContain('01.03.2026 Ada'); // the introduced version, annotated
      expect(annotated).not.toContain('does not exist at');
    });
    expect(router.url).not.toContain('blame=0');
  });

  it('diffs the file against a chosen rename candidate, then clears back', async () => {
    await harness.navigateByUrl('/r/acme/rocket?path=src%2Fengine.ts');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('export const thrust = 1;');
    });

    clickButton('History');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('Continue past the rename?');
    });
    clickButton('Continue past the rename?');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('src/thruster.ts'); // the candidate
    });

    clickButton('Diff'); // the per-candidate "Diff against this predecessor" action

    await vi.waitFor(async () => {
      expect(router.url).toContain(`at=${RENAME_SHA}`);
      expect(router.url).toContain('base=src%2Fthruster.ts');
      const text = await textOnScreen();
      expect(text).toContain('export const thrust = 0;'); // predecessor, on the before side
      expect(text).toContain('export const thrust = 1;'); // the current file, after
    });

    // The before side is a different file, so the per-hunk "Trace" and
    // "◂ Before" steps — which walk the selected file's own timeline — are
    // hidden while comparing.
    const comparingButtons = Array.from(
      harness.routeNativeElement!.querySelectorAll<HTMLButtonElement>('button'),
    );
    expect(comparingButtons.some((b) => b.textContent?.trim() === 'Trace')).toBe(false);
    expect(comparingButtons.some((b) => (b.textContent ?? '').includes('◂ Before'))).toBe(false);

    // Clearing the comparison returns to the commit's own changes (added).
    harness
      .routeNativeElement!.querySelector<HTMLButtonElement>('[aria-label="Stop comparing"]')!
      .click();

    await vi.waitFor(async () => {
      expect(router.url).not.toContain('base=');
      const text = await textOnScreen();
      expect(text).toContain('nothing at parent'); // shown as introduced again
      expect(text).not.toContain('export const thrust = 0;');
    });
  });

  it('continues past a rename into the predecessor file with blame back on', async () => {
    await harness.navigateByUrl('/r/acme/rocket?path=src%2Fengine.ts');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('export const thrust = 1;');
    });

    clickButton('Blame');
    await vi.waitFor(() => {
      expect(router.url).toContain('blame=0');
    });

    clickButton('History');
    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('refactor: rename thruster to engine');
      expect(text).toContain('Continue past the rename?');
    });

    clickButton('Continue past the rename?');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('src/thruster.ts');
      expect(text).toContain('99% match');
      expect(text).toContain('rename');
    });

    clickButton('src/thruster.ts');

    await vi.waitFor(async () => {
      expect(router.url).toContain('path=src%2Fthruster.ts');
      expect(router.url).toContain(`at=${OLD_SHA}`);
      expect(router.url).not.toContain('blame=0');
      // The predecessor's own timeline: a root commit, everything new.
      const text = await textOnScreen();
      expect(text).toContain('initial commit — everything is new');
      expect(text).toContain('01.01.2026 Grace');
    });
  });

  it('renders the rename-away commit from the predecessor history', async () => {
    await harness.navigateByUrl('/r/acme/rocket?path=src%2Fengine.ts');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('export const thrust = 1;');
    });

    clickButton('History');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('Continue past the rename?');
    });

    clickButton('Continue past the rename?');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('src/thruster.ts');
    });
    clickButton('src/thruster.ts');

    await vi.waitFor(() => {
      expect(router.url).toContain('path=src%2Fthruster.ts');
      expect(router.url).toContain(`at=${OLD_SHA}`);
    });

    clickButton('refactor: rename thruster to engine');

    await vi.waitFor(async () => {
      expect(router.url).toContain('path=src%2Fthruster.ts');
      expect(router.url).toContain(`at=${RENAME_SHA}`);
      const text = await textOnScreen();
      expect(text).toContain('src/engine.ts');
      expect(text).toContain('export const thrust = 0;');
      expect(text).toContain('export const thrust = 1;');
      expect(text).not.toContain('does not exist at');
    });
  });
});

describe('ViewerPage · local folder ownership', () => {
  let harness: RouterTestingHarness;

  async function textOnScreen(): Promise<string> {
    await harness.fixture.whenStable();
    harness.detectChanges();
    return harness.routeNativeElement?.textContent ?? '';
  }

  function clickButton(includes: string): void {
    const buttons = Array.from(
      harness.routeNativeElement!.querySelectorAll<HTMLButtonElement>('button'),
    );
    const button = buttons.find((b) => (b.textContent ?? '').includes(includes));
    if (!button) throw new Error(`No button containing "${includes}" found`);
    button.click();
  }

  beforeEach(async () => {
    localStorage.clear();
    // The Owners panel is remembered open, so opening a file lands straight on
    // the folder section the auto-scan fills in.
    localStorage.setItem('time-tracer.owners-open', '1');

    const fs = createMemFs();
    await git.init({ fs, dir: '/', defaultBranch: 'main' });
    await fs.promises.writeFile('/readme.md', 'hello world\n');
    await git.add({ fs, dir: '/', filepath: 'readme.md' });
    await git.commit({
      fs,
      dir: '/',
      message: 'init',
      author: {
        name: 'Ada',
        email: 'ada@example.com',
        timestamp: 1_700_000_000,
        timezoneOffset: 0,
      },
    });

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter(
          [
            {
              path: 'local/:repo',
              component: ViewerPage,
              data: { provider: 'local', owner: 'local' },
            },
          ],
          withComponentInputBinding(),
        ),
        { provide: GIT_PROVIDERS, useExisting: LocalGitProvider, multi: true },
      ],
    });
    TestBed.inject(LocalRepos).register('demo', fs);
    harness = await RouterTestingHarness.create();
  });

  it('auto-displays the folder chart when the repo is read from local data', async () => {
    await harness.navigateByUrl('/local/demo?path=readme.md');

    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('Folder · repository root');
      // The chart fills in with no "Scan this folder" click: the one file is
      // scanned and attributed to its author.
      expect(text).toContain('1 file scanned');
      expect(text).toContain('Ada');
    });
    // The opt-in prompt is gone because the chart is already shown.
    expect(await textOnScreen()).not.toContain('Scan this folder');
  });

  it('keeps the chart from cache after Clear, without bringing back the prompt', async () => {
    await harness.navigateByUrl('/local/demo?path=readme.md');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('1 file scanned');
    });

    // Clearing the scan must not reveal the opt-in button again: the blame is
    // cached, so the chart stays — now folded straight from cache.
    clickButton('Clear');
    const text = await textOnScreen();
    expect(text).toContain('1 file scanned');
    expect(text).toContain('Ada');
    expect(text).not.toContain('Scan this folder');
    // The cache-folded chart has nothing to clear, so the action is gone too.
    expect(
      Array.from(harness.routeNativeElement!.querySelectorAll('button')).some((b) =>
        (b.textContent ?? '').includes('Clear'),
      ),
    ).toBe(false);
  });
});
