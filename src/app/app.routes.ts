import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/loader/loader-page').then((m) => m.LoaderPage),
    title: 'Time Tracer',
  },
  {
    // Query params: `ref` (branch/tag/sha) and `path` (selected file).
    path: 'r/:owner/:repo',
    loadComponent: () => import('./features/viewer/viewer-page').then((m) => m.ViewerPage),
    title: 'Time Tracer',
  },
  {
    path: '**',
    redirectTo: '',
  },
];
