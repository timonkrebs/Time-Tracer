import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { GIT_PROVIDERS } from '../../core/git/git-provider';
import { GithubProvider } from '../../core/git/github/github-provider';
import { LoaderPage } from './loader-page';

describe('LoaderPage', () => {
  let fixture: ComponentFixture<LoaderPage>;
  let navigateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [LoaderPage],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: GIT_PROVIDERS, useExisting: GithubProvider, multi: true },
      ],
    }).compileComponents();

    navigateSpy = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
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

  it('shows an error for unparseable input', async () => {
    enter('definitely not a repo');
    await submit();

    expect(navigateSpy).not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'does not look like a GitHub repository',
    );
  });

  it('shows an error for empty input', async () => {
    await submit();

    expect(navigateSpy).not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Paste a repository URL');
  });
});
