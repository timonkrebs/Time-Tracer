import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { GIT_PROVIDERS } from '../../core/git/git-provider';
import { GithubProvider } from '../../core/git/github/github-provider';
import { ViewerPage } from './viewer-page';

const NEW_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OLD_SHA = 'ffeeddccbbaa99887766554433221100ffeeddcc';
const RENAME_SHA = 'beadfeedbeadfeedbeadfeedbeadfeedbeadfeed';

const NEW_COMMIT = {
  sha: NEW_SHA,
  html_url: `https://github.com/acme/rocket/commit/${NEW_SHA}`,
  commit: {
    message: 'docs: update readme',
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
        { path: 'README.md', type: 'blob', sha: 'blob2', size: 14 },
      ],
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
    // Per-path histories: engine.ts was created by a rename; thruster.ts is
    // its predecessor, last touched at the root commit.
    '/repos/acme/rocket/commits': (url: URL) => {
      const path = url.searchParams.get('path');
      if (path === 'src/engine.ts') return [RENAME_COMMIT];
      if (path === 'src/thruster.ts') return [OLD_COMMIT];
      return [NEW_COMMIT, OLD_COMMIT];
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
        sha: 'blob1',
        size: 24,
        content: btoa('export const thrust = 1;'),
        encoding: 'base64',
      };
    },
    [`/repos/acme/rocket/commits/${NEW_SHA}`]: NEW_COMMIT,
    [`/repos/acme/rocket/commits/${OLD_SHA}`]: OLD_COMMIT,
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
        { path: 'src/thruster.ts', type: 'blob', sha: 'blob1', size: 24 },
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

    clickButton('README.md');

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
      expect(await textOnScreen()).toContain('Go!');
    });

    clickButton('Blame');

    await vi.waitFor(async () => {
      expect(router.url).toContain('blame=1');
      const text = await textOnScreen();
      expect(text).toContain('01.01.2026 Grace'); // line 1: introduced by the root commit
      expect(text).toContain('01.06.2026 Ada'); // lines 2-3: introduced by the newest commit
    });

    clickButton('01.01.2026 Grace');

    await vi.waitFor(async () => {
      expect(router.url).toContain(`at=${OLD_SHA}`);
      expect(router.url).toContain('view=diff');
      // The jump targets the line's position at the introducing commit.
      expect(router.url).toContain('line=1');
      expect(await textOnScreen()).toContain('initial commit — everything is new');
    });
  });

  it('splits the changes view with blame on both sides', async () => {
    await harness.navigateByUrl(`/r/acme/rocket?path=README.md&at=${NEW_SHA}&view=diff`);
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('@@ -1,1 +1,3 @@');
    });

    // The Blame toggle is available in the changes view too.
    clickButton('Blame');

    await vi.waitFor(async () => {
      expect(router.url).toContain('blame=1');
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
      expect(router.url).not.toContain('blame=1');
      expect(await textOnScreen()).toContain('@@ -1,1 +1,3 @@');
    });
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

  it('omits Before when the commit created the file and keeps blame working', async () => {
    // engine.ts was created by the rename commit — there is nothing before.
    await harness.navigateByUrl(`/r/acme/rocket?path=src%2Fengine.ts&at=${RENAME_SHA}&view=diff`);
    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('export const thrust = 1;');
      expect(text).toContain('refactor: rename thruster to engine'); // history loaded
    });
    // No dead-end button that would error with "does not exist at …".
    expect(await textOnScreen()).not.toContain('◂ Before');

    clickButton('Blame');
    await vi.waitFor(async () => {
      const text = await textOnScreen();
      expect(text).toContain('01.03.2026 Ada'); // annotated at this newest version
      expect(text).not.toContain('does not exist at');
    });
    expect(router.url).toContain('blame=1');
  });

  it('continues past a rename into the predecessor file', async () => {
    await harness.navigateByUrl('/r/acme/rocket?path=src%2Fengine.ts');
    await vi.waitFor(async () => {
      expect(await textOnScreen()).toContain('export const thrust = 1;');
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
      expect(text).toContain('100% match');
      expect(text).toContain('rename');
      expect(text).toContain('identical');
    });

    clickButton('src/thruster.ts');

    await vi.waitFor(async () => {
      expect(router.url).toContain('path=src%2Fthruster.ts');
      expect(router.url).toContain(`at=${OLD_SHA}`);
      // The predecessor's own timeline: a root commit, everything new.
      expect(await textOnScreen()).toContain('initial commit — everything is new');
    });
  });
});
