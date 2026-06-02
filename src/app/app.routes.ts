import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/repo-loader/repo-loader.page').then(m => m.RepoLoaderPage),
    title: 'Load Repository'
  },
  {
    path: 'repo',
    loadComponent: () => import('./features/repo-viewer/repo-viewer.page').then(m => m.RepoViewerPage),
    title: 'Repository Viewer'
  },
  {
    path: '**',
    redirectTo: ''
  }
];