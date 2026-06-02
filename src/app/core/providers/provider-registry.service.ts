import { Injectable } from '@angular/core';
import { GitProvider } from './git-provider.interface';
import { GithubProviderService } from './github-provider.service';

@Injectable({ providedIn: 'root' })
export class ProviderRegistryService {
  private providers: GitProvider[] = [];

  constructor(private github: GithubProviderService) {
    this.providers.push(github);
  }

  findProvider(url: string): GitProvider {
    const provider = this.providers.find(p => p.canHandle(url));
    if (!provider) {
      throw new Error('Kein unterstützter Provider für diese URL gefunden.');
    }
    return provider;
  }
}
