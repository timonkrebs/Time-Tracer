import { Routes } from '@angular/router';

/** Shared page title applied to every route. */
const PAGE_TITLE = 'Time Tracer';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/loader/loader-page').then((m) => m.LoaderPage),
    title: PAGE_TITLE,
  },
  {
    // Query params: `ref` (branch/tag/sha), `path` (selected file),
    // `at` (time travel), `view` (file/diff), `blame=0` (annotations off), `line`.
    path: 'r/:owner/:repo',
    loadComponent: () => import('./features/viewer/viewer-page').then((m) => m.ViewerPage),
    data: { provider: 'github' },
    title: PAGE_TITLE,
  },
  {
    path: 'gl/:owner/:repo',
    loadComponent: () => import('./features/viewer/viewer-page').then((m) => m.ViewerPage),
    data: { provider: 'gitlab' },
    title: PAGE_TITLE,
  },
  {
    path: 'azd/:owner/:repo',
    loadComponent: () => import('./features/viewer/viewer-page').then((m) => m.ViewerPage),
    data: { provider: 'azd' },
    title: PAGE_TITLE,
  },
  {
    // Bitbucket Cloud (bitbucket.org). `:owner` is the workspace id.
    path: 'bb/:owner/:repo',
    loadComponent: () => import('./features/viewer/viewer-page').then((m) => m.ViewerPage),
    data: { provider: 'bitbucket' },
    title: PAGE_TITLE,
  },
  {
    // Bitbucket Server / Data Center. `:owner` is the project key; the instance
    // origin travels in the `host` query param (also used by GitHub Enterprise
    // on `r/…` and self-hosted GitLab on `gl/…`).
    path: 'bbs/:owner/:repo',
    loadComponent: () => import('./features/viewer/viewer-page').then((m) => m.ViewerPage),
    data: { provider: 'bitbucket-server' },
    title: PAGE_TITLE,
  },
  {
    path: 'local/:repo',
    loadComponent: () => import('./features/viewer/viewer-page').then((m) => m.ViewerPage),
    data: { provider: 'local', owner: 'local' },
    title: PAGE_TITLE,
  },
  {
    path: '**',
    redirectTo: '',
  },
];
