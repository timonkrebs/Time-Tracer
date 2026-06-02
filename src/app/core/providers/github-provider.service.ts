import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { GitProvider } from './git-provider.interface';
import { RepoUrl } from '../models/repo-url.model';
import { RepoMetadata, RepoLoadOptions } from '../models/git-provider.model';
import { RepoTreeNode } from '../models/repo-tree.model';
import { RepoFile } from '../models/repo-file.model';
import { RepoUrlParserService } from '../services/repo-url-parser.service';

@Injectable({ providedIn: 'root' })
export class GithubProviderService implements GitProvider {
  readonly id = 'github';
  readonly label = 'GitHub';

  constructor(
    private http: HttpClient,
    private parser: RepoUrlParserService
  ) {}

  canHandle(url: string): boolean {
    return url.includes('github.com');
  }

  parseUrl(url: string): RepoUrl {
    return this.parser.parse(url);
  }

  private getHeaders(options?: RepoLoadOptions): HttpHeaders {
    let headers = new HttpHeaders({
      'Accept': 'application/vnd.github.v3+json'
    });
    if (options?.token) {
      headers = headers.set('Authorization', `Bearer ${options.token}`);
    }
    return headers;
  }

  async getRepositoryMetadata(repo: RepoUrl, options?: RepoLoadOptions): Promise<RepoMetadata> {
    const url = `https://api.github.com/repos/${repo.owner}/${repo.name}`;
    try {
      const response = await firstValueFrom(
        this.http.get<any>(url, { headers: this.getHeaders(options) })
      );

      return {
        id: response.id,
        name: response.name,
        fullName: response.full_name,
        defaultBranch: response.default_branch,
        description: response.description,
        size: response.size,
        isPrivate: response.private
      };
    } catch (error: any) {
      throw this.handleError(error);
    }
  }

  async getTree(repo: RepoUrl, options?: RepoLoadOptions): Promise<RepoTreeNode[]> {
    const ref = options?.ref || 'HEAD';
    const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/${ref}?recursive=1`;

    try {
      const response = await firstValueFrom(
        this.http.get<any>(url, { headers: this.getHeaders(options) })
      );

      return response.tree.map((item: any) => ({
        path: item.path,
        name: item.path.split('/').pop(),
        type: item.type === 'blob' ? 'file' : 'directory',
        size: item.size,
        sha: item.sha,
        url: item.url
      }));
    } catch (error: any) {
      throw this.handleError(error);
    }
  }

  async getFile(repo: RepoUrl, path: string, options?: RepoLoadOptions): Promise<RepoFile> {
    const ref = options?.ref || 'HEAD';
    const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${ref}`;

    try {
      const response = await firstValueFrom(
        this.http.get<any>(url, { headers: this.getHeaders(options) })
      );

      const isBinaryFallback = this.checkIfBinary(path);
      const isTooLarge = options?.maxFileSizeBytes ? (response.size > options.maxFileSizeBytes) : false;

      let content = undefined;
      let encoding: RepoFile['encoding'] = 'unknown';

      if (!isBinaryFallback && !isTooLarge) {
          if (response.encoding === 'base64') {
             try {
                // simple base64 decode for utf-8
                const binaryString = atob(response.content);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                content = new TextDecoder('utf-8').decode(bytes);
                encoding = 'utf-8';
             } catch(e) {
                 encoding = 'base64';
                 content = response.content;
             }
          }
      }

      return {
        path: response.path,
        name: response.name,
        size: response.size,
        sha: response.sha,
        content: content,
        encoding: encoding,
        isBinary: isBinaryFallback,
        isTooLarge: isTooLarge
      };
    } catch (error: any) {
       // fallback to raw if size is large but not too large, or if contents API fails
       throw this.handleError(error);
    }
  }

  private checkIfBinary(path: string): boolean {
    const ext = path.split('.').pop()?.toLowerCase();
    const binaryExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'zip', 'gz', 'mp4', 'mov', 'woff', 'woff2', 'ttf'];
    return !!ext && binaryExts.includes(ext);
  }

  private handleError(error: any): Error {
    if (error.status === 403 && error.headers?.get('x-ratelimit-remaining') === '0') {
      return new Error('GitHub Rate Limit erreicht. Optional Token verwenden.');
    }
    if (error.status === 404) {
      return new Error('Repository nicht gefunden oder privat.');
    }
    if (error.status === 401) {
      return new Error('Token ungültig oder nicht ausreichend berechtigt.');
    }
    return new Error(error.message || 'Ein unbekannter Fehler ist aufgetreten.');
  }
}