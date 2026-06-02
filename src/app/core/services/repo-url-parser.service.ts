import { Injectable } from '@angular/core';
import { RepoUrl } from '../models/repo-url.model';

@Injectable({ providedIn: 'root' })
export class RepoUrlParserService {
  parse(url: string): RepoUrl {
    const trimmed = url.trim();
    let cleanUrl = trimmed;

    // Remove .git suffix
    if (cleanUrl.endsWith('.git')) {
      cleanUrl = cleanUrl.slice(0, -4);
    }

    // Try to parse as standard URL
    try {
      // Add https:// if no protocol is present
      if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://') && !cleanUrl.startsWith('git@')) {
         cleanUrl = 'https://' + cleanUrl;
      }

      // Handle git@github.com:owner/repo
      if (cleanUrl.startsWith('git@')) {
          const match = cleanUrl.match(/git@([^:]+):([^\/]+)\/(.+)/);
          if (match) {
            const domain = match[1];
            const owner = match[2];
            const name = match[3];

            return {
                originalUrl: url,
                provider: domain.includes('github.com') ? 'github' : 'unknown',
                owner,
                name
            };
          }
      }

      const parsed = new URL(cleanUrl);

      if (parsed.hostname === 'github.com') {
        const parts = parsed.pathname.split('/').filter(p => p);
        if (parts.length >= 2) {
          const owner = parts[0];
          const name = parts[1];
          let ref: string | undefined;
          let path: string | undefined;

          // e.g. /owner/repo/tree/main/src
          if (parts.length >= 4 && (parts[2] === 'tree' || parts[2] === 'blob')) {
              ref = parts[3];
              path = parts.slice(4).join('/');
          }

          return {
            originalUrl: url,
            provider: 'github',
            owner,
            name,
            ref,
            path
          };
        }
      }

      return {
        originalUrl: url,
        provider: 'unknown',
        owner: '',
        name: ''
      };

    } catch (e) {
      return {
        originalUrl: url,
        provider: 'unknown',
        owner: '',
        name: ''
      };
    }
  }
}