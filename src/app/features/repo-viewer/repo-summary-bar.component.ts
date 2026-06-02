import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RepoUrl } from '../../core/models/repo-url.model';
import { RepoMetadata } from '../../core/models/git-provider.model';
import { LucideAngularModule, GitBranch, FolderGit2 } from 'lucide-angular';

@Component({
  selector: 'app-repo-summary-bar',
  standalone: true,
  imports: [CommonModule, LucideAngularModule],
  template: `
    <div class="h-12 border-b border-gray-200 bg-gray-50 flex items-center px-4 justify-between shadow-sm">
      <div class="flex items-center space-x-4">
        <div class="flex items-center text-gray-800 font-semibold" *ngIf="repo">
          <lucide-icon name="folder-git-2" [size]="18" class="mr-2 text-gray-500"></lucide-icon>
          <span>{{ repo.owner }} / {{ repo.name }}</span>
        </div>

        <div class="flex items-center text-sm text-gray-600 bg-gray-200 px-2 py-1 rounded-md" *ngIf="metadata">
          <lucide-icon name="git-branch" [size]="14" class="mr-1"></lucide-icon>
          <span>{{ repo?.ref || metadata.defaultBranch }}</span>
        </div>
      </div>

      <div class="flex items-center text-sm text-gray-500 space-x-4">
        <div *ngIf="fileCount !== undefined">
           {{ fileCount }} files
        </div>
        <div *ngIf="dirCount !== undefined">
           {{ dirCount }} folders
        </div>
      </div>
    </div>
  `
})
export class RepoSummaryBarComponent {
  @Input() repo: RepoUrl | null = null;
  @Input() metadata: RepoMetadata | null = null;
  @Input() fileCount?: number;
  @Input() dirCount?: number;

  readonly GitBranch = GitBranch;
  readonly FolderGit2 = FolderGit2;
}