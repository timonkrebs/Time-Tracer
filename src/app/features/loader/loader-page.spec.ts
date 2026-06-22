import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { AccessTokens } from '../../core/git/access-tokens';
import { GIT_PROVIDERS } from '../../core/git/git-provider';
import { GithubProvider } from '../../core/git/github/github-provider';
import { GitlabProvider } from '../../core/git/gitlab/gitlab-provider';
import { AzdProvider } from '../../core/git/azd/azd-provider';
import { LoaderPage } from './loader-page';

describe('LoaderPage', () => {
  let fixture: ComponentFixture<LoaderPage>;
  let navigateSpy: ReturnType<typeof vi.spyOn>;
  let resolveRefPathSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [LoaderPage],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: GIT_PROVIDERS, useExisting: GithubProvider, multi: true },
        { provide: GIT_PROVIDERS, useExisting: GitlabProvider, multi: true },
        { provide: GIT_PROVIDERS, useExisting: AzdProvider, multi: true },
      ],
    }).compileComponents();

    navigateSpy = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    resolveRefPathSpy = vi
      .spyOn(TestBed.inject(GithubProvider), 'resolveRefPath')
      .mockResolvedValue(null);
    fixture = TestBed.createComponent(LoaderPage);
    await fixture.whenStable();
  });

  function enter(value: string): void {
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  async function submit(): Promise<void> {
    const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
  }

  async function openTokens(): Promise<HTMLElement> {
    const element = fixture.nativeElement as HTMLElement;
    const toggle = Array.from(element.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Personal access tokens'),
    )!;
    toggle.click();
    await fixture.whenStable();
    return element;
  }

  it('navigates to the viewer for a valid repository URL', async () => {
    enter('https://github.com/angular/angular/tree/main/packages');
    await submit();

    expect(navigateSpy).toHaveBeenCalledWith(['/r', 'angular', 'angular'], {
      queryParams: { ref: 'main', path: 'packages' },
    });
  });

  it('re-splits branch names containing slashes via the provider', async () => {
    resolveRefPathSpy.mockResolvedValue({ ref: 'claude/brave-hamilton' });

    enter('https://github.com/timonkrebs/Time-Tracer/tree/claude/brave-hamilton');
    await submit();

    expect(resolveRefPathSpy).toHaveBeenCalledWith(
      { provider: 'github', owner: 'timonkrebs', repo: 'Time-Tracer' },
      'claude/brave-hamilton',
    );
    expect(navigateSpy).toHaveBeenCalledWith(['/r', 'timonkrebs', 'Time-Tracer'], {
      queryParams: { ref: 'claude/brave-hamilton' },
    });
  });

  it('skips ref resolution for unambiguous URLs', async () => {
    enter('https://github.com/a/b/tree/main');
    await submit();

    expect(resolveRefPathSpy).not.toHaveBeenCalled();
    expect(navigateSpy).toHaveBeenCalledWith(['/r', 'a', 'b'], { queryParams: { ref: 'main' } });
  });

  it('skips ref resolution for full commit shas', async () => {
    const sha = 'a'.repeat(40);
    enter(`https://github.com/a/b/tree/${sha}/src`);
    await submit();

    expect(resolveRefPathSpy).not.toHaveBeenCalled();
    expect(navigateSpy).toHaveBeenCalledWith(['/r', 'a', 'b'], {
      queryParams: { ref: sha, path: 'src' },
    });
  });

  it('routes GitLab URLs to the GitLab viewer', async () => {
    enter('https://gitlab.com/gitlab-org/gitlab.git');
    await submit();

    expect(navigateSpy).toHaveBeenCalledWith(['/gl', 'gitlab-org', 'gitlab'], {
      queryParams: {},
    });
  });

  it('routes Azure DevOps URLs to the AZD viewer', async () => {
    enter('https://dev.azure.com/fhnw/Services/_git/A1418-CIT.IAM.EBC/pullrequest/13619');
    await submit();

    expect(navigateSpy).toHaveBeenCalledWith(['/azd', 'fhnw/Services', 'A1418-CIT.IAM.EBC'], {
      queryParams: {},
    });
  });

  it('shows an error for unparseable input', async () => {
    enter('definitely not a repo');
    await submit();

    expect(navigateSpy).not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'does not look like a hosted repository',
    );
  });

  it('opens a self-hosted instance with the host query param', async () => {
    const element = fixture.nativeElement as HTMLElement;
    const toggle = Array.from(element.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Self-hosted / custom instance'),
    )!;
    toggle.click();
    await fixture.whenStable();

    const host = element.querySelector<HTMLInputElement>('#custom-host')!;
    host.value = 'https://github.example.com';
    host.dispatchEvent(new Event('input'));
    const repo = element.querySelector<HTMLInputElement>('#custom-repo')!;
    repo.value = 'acme/rocket';
    repo.dispatchEvent(new Event('input'));
    await fixture.whenStable();

    const open = Array.from(element.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Open instance repository'),
    )!;
    open.click();
    await fixture.whenStable();

    expect(navigateSpy).toHaveBeenCalledWith(['/r', 'acme', 'rocket'], {
      queryParams: { host: 'https://github.example.com' },
    });
  });

  it('rejects a dangerous instance URL instead of navigating', async () => {
    const element = fixture.nativeElement as HTMLElement;
    const toggle = Array.from(element.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Self-hosted / custom instance'),
    )!;
    toggle.click();
    await fixture.whenStable();

    const host = element.querySelector<HTMLInputElement>('#custom-host')!;
    host.value = "javascript:alert('xss')";
    host.dispatchEvent(new Event('input'));
    const repo = element.querySelector<HTMLInputElement>('#custom-repo')!;
    repo.value = 'acme/rocket';
    repo.dispatchEvent(new Event('input'));
    await fixture.whenStable();

    const open = Array.from(element.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Open instance repository'),
    )!;
    open.click();
    await fixture.whenStable();

    expect(navigateSpy).not.toHaveBeenCalled();
    expect(element.textContent).toContain('private-network and metadata addresses are not allowed');
  });

  it('refuses a private-network instance host without navigating', async () => {
    const element = fixture.nativeElement as HTMLElement;
    const toggle = Array.from(element.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Self-hosted / custom instance'),
    )!;
    toggle.click();
    await fixture.whenStable();

    const host = element.querySelector<HTMLInputElement>('#custom-host')!;
    host.value = 'http://192.168.1.1';
    host.dispatchEvent(new Event('input'));
    const repo = element.querySelector<HTMLInputElement>('#custom-repo')!;
    repo.value = 'acme/rocket';
    repo.dispatchEvent(new Event('input'));
    await fixture.whenStable();

    const open = Array.from(element.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Open instance repository'),
    )!;
    open.click();
    await fixture.whenStable();

    expect(navigateSpy).not.toHaveBeenCalled();
    expect(element.textContent).toContain('private-network and metadata addresses are not allowed');
  });

  it('shows an error for empty input', async () => {
    await submit();

    expect(navigateSpy).not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Paste a repository URL');
  });

  it('stores personal access tokens typed into the tokens section', async () => {
    const element = await openTokens();

    const githubInput = element.querySelector<HTMLInputElement>('#github-token')!;
    githubInput.value = ' ghp_secret ';
    githubInput.dispatchEvent(new Event('input'));
    const azdInput = element.querySelector<HTMLInputElement>('#azd-token')!;
    azdInput.value = 'azd-pat';
    azdInput.dispatchEvent(new Event('input'));

    const tokens = TestBed.inject(AccessTokens);
    expect(tokens.tokenFor('github')).toBe('ghp_secret');
    expect(tokens.tokenFor('azd')).toBe('azd-pat');
    expect(localStorage.getItem('time-tracer.token.github')).toBe('ghp_secret');
  });

  it('never renders a stored token back into the field, yet keeps it usable', async () => {
    // A token saved on a previous visit, then the page is re-created (revisit).
    TestBed.inject(AccessTokens).setToken('github', 'ghp_storedsecret');
    fixture = TestBed.createComponent(LoaderPage);
    await fixture.whenStable();
    const element = await openTokens();

    const githubInput = element.querySelector<HTMLInputElement>('#github-token')!;
    // Write-only: the secret is never placed in the DOM…
    expect(githubInput.value).toBe('');
    expect(githubInput.type).toBe('password');
    // …yet the saved state is surfaced so the token stays usable and clearable.
    expect(element.querySelector('[aria-label="Clear GitHub token"]')).not.toBeNull();
  });

  it('removes a stored token only through the explicit Clear control', async () => {
    const tokens = TestBed.inject(AccessTokens);
    tokens.setToken('github', 'ghp_stored');
    fixture = TestBed.createComponent(LoaderPage);
    await fixture.whenStable();
    const element = await openTokens();

    // Emptying a write-only field must not silently drop the saved token.
    const githubInput = element.querySelector<HTMLInputElement>('#github-token')!;
    githubInput.value = '';
    githubInput.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(tokens.tokenFor('github')).toBe('ghp_stored');

    const clear = element.querySelector<HTMLButtonElement>('[aria-label="Clear GitHub token"]')!;
    clear.click();
    await fixture.whenStable();
    expect(tokens.tokenFor('github')).toBe('');
    expect(localStorage.getItem('time-tracer.token.github')).toBeNull();
    expect(element.querySelector('[aria-label="Clear GitHub token"]')).toBeNull();
  });
});
