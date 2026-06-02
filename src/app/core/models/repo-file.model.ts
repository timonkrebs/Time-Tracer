export interface RepoFile {
  path: string;
  name: string;
  size?: number;
  sha?: string;
  mimeType?: string;
  language?: string;
  encoding?: 'utf-8' | 'base64' | 'binary' | 'unknown';
  content?: string;
  isBinary: boolean;
  isTooLarge: boolean;
}