import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RepoFile } from '../../core/models/repo-file.model';

@Component({
  selector: 'app-repo-file-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="h-full flex flex-col bg-white">
      <!-- Header -->
      <div class="border-b border-gray-200 p-3 bg-gray-50 flex justify-between items-center text-sm">
        <div class="font-medium text-gray-700 truncate" *ngIf="file">
          {{ file.path }}
        </div>
        <div class="text-gray-500" *ngIf="file?.size !== undefined">
          {{ formatSize(file?.size || 0) }}
        </div>
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-auto bg-white p-4">
        <ng-container *ngIf="!file">
          <div class="h-full flex items-center justify-center text-gray-500">
            Select a file to view its contents.
          </div>
        </ng-container>

        <ng-container *ngIf="file">
          <!-- Binary / Too large -->
          <div *ngIf="file.isBinary" class="h-full flex flex-col items-center justify-center text-gray-500">
             <p class="mb-2">This file is binary and cannot be displayed.</p>
          </div>

          <div *ngIf="file.isTooLarge" class="h-full flex flex-col items-center justify-center text-gray-500">
             <p class="mb-2">This file is too large to be displayed.</p>
          </div>

          <!-- Text content -->
          <pre *ngIf="!file.isBinary && !file.isTooLarge && file.content !== undefined"
               class="font-mono text-sm text-gray-800 whitespace-pre-wrap break-all"
               style="tab-size: 4;">{{ file.content }}</pre>

          <div *ngIf="!file.isBinary && !file.isTooLarge && file.content === undefined" class="h-full flex flex-col items-center justify-center text-gray-500">
             <p class="mb-2">Loading content...</p>
          </div>
        </ng-container>
      </div>
    </div>
  `
})
export class RepoFileViewerComponent {
  @Input() file: RepoFile | null = null;

  formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}