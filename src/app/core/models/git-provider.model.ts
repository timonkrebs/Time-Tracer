export interface RepoMetadata {
  id: number;
  name: string;
  fullName: string;
  defaultBranch: string;
  description: string | null;
  size?: number;
  isPrivate: boolean;
}

export interface RepoLoadOptions {
  ref?: string;
  token?: string;
  maxFileSizeBytes?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
}