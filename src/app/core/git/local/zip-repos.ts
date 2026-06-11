import { Injectable, inject } from '@angular/core';

import { createMemFs } from './mem-fs';
import { LocalRepos } from './local-repos';
import { loadGit } from './local-provider';

/** Zip metadata entries that are noise, not repository content. */
const IGNORED_PREFIXES = ['__MACOSX/'];

/**
 * Imports a repository from a `.zip` file: entries are unpacked into an
 * in-memory filesystem and registered with {@link LocalRepos}. Archives that
 * contain a `.git` directory keep their full history; plain source archives
 * (e.g. GitHub's "Download ZIP") get a single synthetic "Imported from …"
 * commit so the rest of the app works uniformly.
 */
@Injectable({ providedIn: 'root' })
export class ZipRepos {
  private readonly repos = inject(LocalRepos);

  /** Unpacks `file` and returns the registered repo name. */
  async open(file: File): Promise<string> {
    const { unzip } = await import('fflate');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const raw = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
      unzip(bytes, (error, entries) => (error ? reject(error) : resolve(entries)));
    });

    const entries = new Map<string, Uint8Array>();
    for (const [name, data] of Object.entries(raw)) {
      if (name.endsWith('/')) continue; // directory marker
      if (IGNORED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      entries.set(name, data);
    }
    if (entries.size === 0) {
      throw new Error(`"${file.name}" contains no files.`);
    }

    // GitHub/GitLab archives nest everything in a single `repo-ref/` folder.
    const rootPrefix = commonRootPrefix([...entries.keys()]);
    const fs = createMemFs();
    let hasGitDir = false;
    for (const [name, data] of entries) {
      const path = name.slice(rootPrefix.length);
      if (!path) continue;
      if (path === '.git/HEAD') hasGitDir = true;
      await fs.promises.writeFile(`/${path}`, data);
    }

    if (!hasGitDir) {
      const git = await loadGit();
      await git.init({ fs, dir: '/', defaultBranch: 'main' });
      await git.add({ fs, dir: '/', filepath: '.' });
      await git.commit({
        fs,
        dir: '/',
        message: `Imported from ${file.name}`,
        author: { name: 'Time Tracer', email: 'zip@time-tracer.local' },
      });
    }

    const name = file.name.replace(/\.zip$/i, '') || 'archive';
    this.repos.register(name, fs);
    return name;
  }
}

/** `repo-main/` when every entry lives under that single folder, else ''. */
function commonRootPrefix(names: string[]): string {
  const firstSegments = new Set(names.map((name) => name.split('/', 1)[0]));
  if (firstSegments.size !== 1) return '';
  const root = [...firstSegments][0];
  // Only treat it as a wrapper when nothing sits AT the root itself.
  return names.every((name) => name.startsWith(`${root}/`)) ? `${root}/` : '';
}
