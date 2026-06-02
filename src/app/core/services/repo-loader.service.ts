import { Injectable } from '@angular/core';
import { RepoLoaderStore } from './repo-loader-store.service';
import { ProviderRegistryService } from '../providers/provider-registry.service';
import { RepoLoadOptions } from '../models/git-provider.model';

@Injectable({ providedIn: 'root' })
export class RepoLoaderService {
  constructor(
    private store: RepoLoaderStore,
    private registry: ProviderRegistryService
  ) {}

  async loadRepository(url: string, options?: RepoLoadOptions): Promise<void> {
    try {
      this.store.reset();
      this.store.state.set({ status: 'parsing-url' });

      const provider = this.registry.findProvider(url);
      const repo = provider.parseUrl(url);

      this.store.state.set({ status: 'loading-metadata' });
      const metadata = await provider.getRepositoryMetadata(repo, options);

      this.store.state.set({ status: 'loading-tree' });

      const loadOptions: RepoLoadOptions = {
        ...options,
        ref: repo.ref ?? metadata.defaultBranch
      };

      const tree = await provider.getTree(repo, loadOptions);

      // Hierarchical tree building
      const hierarchicalTree = this.buildTree(tree);

      this.store.repo.set(repo);
      this.store.metadata.set(metadata);
      this.store.tree.set(hierarchicalTree);

      this.store.state.set({ status: 'ready' });

      // Automatically load README if exists
      const readmeNode = tree.find(n => n.name.toLowerCase() === 'readme.md' && n.type === 'file');
      if (readmeNode) {
          await this.loadFile(readmeNode.path, loadOptions);
      }

    } catch (error: any) {
      this.store.state.set({ status: 'error', message: error.message, cause: error });
    }
  }

  async loadFile(path: string, options?: RepoLoadOptions): Promise<void> {
      const repo = this.store.repo();
      const metadata = this.store.metadata();
      if (!repo || !metadata) return;

      try {
          const provider = this.registry.findProvider(repo.originalUrl);

          const loadOptions: RepoLoadOptions = {
             ...options,
             ref: repo.ref ?? metadata.defaultBranch
          };

          const file = await provider.getFile(repo, path, loadOptions);
          this.store.selectedFile.set(file);
          this.store.selectedPath.set(path);
      } catch (error: any) {
          console.error('Failed to load file', error);
      }
  }

  private buildTree(flatTree: any[]): any[] {
     const root: any[] = [];
     const map = new Map<string, any>();

     // Create nodes
     for (const item of flatTree) {
         map.set(item.path, { ...item, children: item.type === 'directory' ? [] : undefined });
     }

     for (const item of flatTree) {
         const node = map.get(item.path);
         const parts = item.path.split('/');

         if (parts.length === 1) {
             root.push(node);
         } else {
             parts.pop();
             const parentPath = parts.join('/');
             const parentNode = map.get(parentPath);
             if (parentNode && parentNode.children) {
                 parentNode.children.push(node);
             }
         }
     }

     return this.sortTree(root);
  }

  private sortTree(nodes: any[]): any[] {
     nodes.sort((a, b) => {
         if (a.type === 'directory' && b.type === 'file') return -1;
         if (a.type === 'file' && b.type === 'directory') return 1;
         return a.name.localeCompare(b.name);
     });

     for (const node of nodes) {
         if (node.children) {
             node.children = this.sortTree(node.children);
         }
     }

     return nodes;
  }
}