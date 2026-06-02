import { Component, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { RepoLoaderService } from '../../core/services/repo-loader.service';
import { RepoLoaderStore } from '../../core/services/repo-loader-store.service';
import { RepoTreeComponent } from './repo-tree.component';
import { RepoFileViewerComponent } from './repo-file-viewer.component';
import { RepoSummaryBarComponent } from './repo-summary-bar.component';
import { LucideAngularModule, ArrowLeft } from 'lucide-angular';

@Component({
  selector: 'app-repo-viewer-page',
  standalone: true,
  imports: [CommonModule, RepoTreeComponent, RepoFileViewerComponent, RepoSummaryBarComponent, LucideAngularModule],
  template: `
    <div class="h-screen flex flex-col bg-gray-100 overflow-hidden">
      <!-- Top Navigation -->
      <header class="bg-white border-b border-gray-200 h-14 flex items-center px-4 shrink-0 shadow-sm z-10">
        <button
          (click)="goBack()"
          class="flex items-center text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
        >
          <lucide-icon name="arrow-left" [size]="16" class="mr-2"></lucide-icon>
          Back to Load
        </button>
        <div class="ml-4 font-bold text-gray-800 border-l border-gray-300 pl-4">time-trace-repo-viewer</div>
      </header>

      <!-- Main Content -->
      <ng-container [ngSwitch]="state().status">

        <!-- Loading State -->
        <div *ngSwitchCase="'parsing-url'" class="flex-1 flex flex-col items-center justify-center">
            <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
            <p class="text-gray-600">Parsing URL...</p>
        </div>
        <div *ngSwitchCase="'loading-metadata'" class="flex-1 flex flex-col items-center justify-center">
            <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
            <p class="text-gray-600">Loading metadata...</p>
        </div>
        <div *ngSwitchCase="'loading-tree'" class="flex-1 flex flex-col items-center justify-center">
            <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
            <p class="text-gray-600">Loading repository tree...</p>
        </div>

        <!-- Error State -->
        <div *ngSwitchCase="'error'" class="flex-1 flex flex-col items-center justify-center p-6 text-center">
            <div class="text-red-500 text-5xl mb-4">⚠️</div>
            <h2 class="text-xl font-bold text-gray-800 mb-2">Error Loading Repository</h2>
            <p class="text-red-600 mb-6 max-w-md" *ngIf="state().status === 'error'">{{ $any(state()).message }}</p>
            <button (click)="goBack()" class="bg-gray-200 hover:bg-gray-300 text-gray-800 font-medium py-2 px-4 rounded">
              Try Another URL
            </button>
        </div>

        <!-- Ready State (Desktop Split Pane) -->
        <div *ngSwitchCase="'ready'" class="flex-1 flex flex-col min-h-0">
          <app-repo-summary-bar
            [repo]="repo()"
            [metadata]="metadata()"
            [fileCount]="fileCount()"
            [dirCount]="dirCount()"
          ></app-repo-summary-bar>

          <div class="flex-1 flex min-h-0">
            <!-- Sidebar (Tree) -->
            <div class="w-72 flex-shrink-0 flex flex-col bg-white border-r border-gray-200">
              <app-repo-tree
                [tree]="tree()"
                [selectedPath]="selectedPath()"
                (fileSelected)="onFileSelected($event)"
              ></app-repo-tree>
            </div>

            <!-- Main Area (File Viewer) -->
            <div class="flex-1 min-w-0 bg-gray-50">
               <app-repo-file-viewer
                 [file]="selectedFile()"
               ></app-repo-file-viewer>
            </div>
          </div>
        </div>

      </ng-container>
    </div>
  `
})
export class RepoViewerPage implements OnInit {

  // Expose signals to template
  state;
  repo;
  metadata;
  tree;
  selectedFile;
  selectedPath;
  fileCount;
  dirCount;

  readonly ArrowLeft = ArrowLeft;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private loaderService: RepoLoaderService,
    private store: RepoLoaderStore
  ) {
      this.state = this.store.state;
      this.repo = this.store.repo;
      this.metadata = this.store.metadata;
      this.tree = this.store.tree;
      this.selectedFile = this.store.selectedFile;
      this.selectedPath = this.store.selectedPath;
      this.fileCount = this.store.fileCount;
      this.dirCount = this.store.directoryCount;
  }

  ngOnInit() {
    this.route.queryParams.subscribe(params => {
      const url = params['url'];
      if (url) {
        this.loaderService.loadRepository(url);
      } else {
        this.router.navigate(['/']);
      }
    });
  }

  onFileSelected(path: string) {
    this.loaderService.loadFile(path);
  }

  goBack() {
    this.router.navigate(['/']);
  }
}