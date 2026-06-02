export interface RepoTreeNode {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  sha?: string;
  url?: string;
  children?: RepoTreeNode[];
}