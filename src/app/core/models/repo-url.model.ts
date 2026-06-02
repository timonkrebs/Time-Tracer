export interface RepoUrl {
  originalUrl: string;
  provider: 'github' | 'gitlab' | 'bitbucket' | 'unknown';
  owner: string;
  name: string;
  ref?: string;
  path?: string;
}