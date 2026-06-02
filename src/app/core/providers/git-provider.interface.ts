import { RepoMetadata, RepoLoadOptions } from '../models/git-provider.model';
import { RepoUrl } from '../models/repo-url.model';
import { RepoTreeNode } from '../models/repo-tree.model';
import { RepoFile } from '../models/repo-file.model';

export interface GitProvider {
  readonly id: string;
  readonly label: string;

  canHandle(url: string): boolean;
  parseUrl(url: string): RepoUrl;
  getRepositoryMetadata(repo: RepoUrl, options?: RepoLoadOptions): Promise<RepoMetadata>;
  getTree(repo: RepoUrl, options?: RepoLoadOptions): Promise<RepoTreeNode[]>;
  getFile(repo: RepoUrl, path: string, options?: RepoLoadOptions): Promise<RepoFile>;
}