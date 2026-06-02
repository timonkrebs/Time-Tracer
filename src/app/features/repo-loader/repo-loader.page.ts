import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { RepoUrlFormComponent } from './repo-url-form.component';

@Component({
  selector: 'app-repo-loader-page',
  standalone: true,
  imports: [CommonModule, RepoUrlFormComponent],
  template: `
    <div class="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div class="w-full max-w-4xl flex flex-col items-center">
        <h1 class="text-4xl font-bold text-gray-900 mb-2">time-trace-repo-viewer</h1>
        <p class="text-gray-600 mb-8 text-center max-w-lg">
          Client-only Angular app for loading and viewing Git repositories directly in the browser. No backend required.
        </p>

        <app-repo-url-form (loadRequested)="onLoadRequested($event)"></app-repo-url-form>
      </div>
    </div>
  `
})
export class RepoLoaderPage {
  constructor(private router: Router) {}

  onLoadRequested(url: string) {
    this.router.navigate(['/repo'], { queryParams: { url } });
  }
}