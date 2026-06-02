import { Injectable, signal, computed } from '@angular/core';
import { LoadState } from '../models/load-state.model';
import { RepoUrl } from '../models/repo-url.model';
import { RepoMetadata } from '../models/git-provider.model';
import { RepoTreeNode } from '../models/repo-tree.model';
import { RepoFile } from '../models/repo-file.model';

@Injectable({ providedIn: 'root' })
export class RepoLoaderStore {
  readonly state = signal<LoadState>({ status: 'idle' });
  readonly repo = signal<RepoUrl | null>(null);
  readonly metadata = signal<RepoMetadata | null>(null);
  readonly tree = signal<RepoTreeNode[]>([]);
  readonly selectedFile = signal<RepoFile | null>(null);
  readonly selectedPath = signal<string | null>(null);

  readonly fileCount = computed(() => {
     return this.tree().filter(node => node.type === 'file').length;
  });

  readonly directoryCount = computed(() => {
     return this.tree().filter(node => node.type === 'directory').length;
  });

  reset() {
      this.state.set({ status: 'idle' });
      this.repo.set(null);
      this.metadata.set(null);
      this.tree.set([]);
      this.selectedFile.set(null);
      this.selectedPath.set(null);
  }
}