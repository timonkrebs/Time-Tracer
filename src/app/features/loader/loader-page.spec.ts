import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { GIT_PROVIDERS } from '../../core/git/git-provider';
import { GithubProvider } from '../../core/git/github/github-provider';
import { GitlabProvider } from '../../core/git/gitlab/gitlab-provider';
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

  it('shows an error for unparseable input', async () => {
    enter('definitely not a repo');
    await submit();

    expect(navigateSpy).not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'does not look like a GitHub or GitLab repository',
    );
  });

  it('shows an error for empty input', async () => {
    await submit();

    expect(navigateSpy).not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Paste a repository URL');
  });
});
