import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/loader/loader-page').then((m) => m.LoaderPage),
    title: 'Time Tracer',
  },
  {
    // Query params: `ref` (branch/tag/sha), `path` (selected file),
    // `at` (time travel), `view` (file/diff), `blame`, `line`.
    path: 'r/:owner/:repo',
    loadComponent: () => import('./features/viewer/viewer-page').then((m) => m.ViewerPage),
    data: { provider: 'github' },
    title: 'Time Tracer',
  },
  {
    path: 'gl/:owner/:repo',
    loadComponent: () => import('./features/viewer/viewer-page').then((m) => m.ViewerPage),
    data: { provider: 'gitlab' },
    title: 'Time Tracer',
  },
  {
    path: 'azd/:owner/:repo',
    loadComponent: () => import('./features/viewer/viewer-page').then((m) => m.ViewerPage),
    data: { provider: 'azd' },
    title: 'Time Tracer',
  },
  {
    path: 'local/:repo',
    loadComponent: () => import('./features/viewer/viewer-page').then((m) => m.ViewerPage),
    data: { provider: 'local', owner: 'local' },
    title: 'Time Tracer',
  },
  {
    path: '**',
    redirectTo: '',
  },
];
