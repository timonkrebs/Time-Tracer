import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';

import { routes } from './app.routes';
import { GIT_PROVIDERS } from './core/git/git-provider';
import { GithubProvider } from './core/git/github/github-provider';
import { GitlabProvider } from './core/git/gitlab/gitlab-provider';
import { LocalGitProvider } from './core/git/local/local-provider';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding()),
    { provide: GIT_PROVIDERS, useExisting: GithubProvider, multi: true },
    { provide: GIT_PROVIDERS, useExisting: GitlabProvider, multi: true },
    { provide: GIT_PROVIDERS, useExisting: LocalGitProvider, multi: true },
  ],
};
