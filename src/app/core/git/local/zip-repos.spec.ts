import { TestBed } from '@angular/core/testing';
import { strToU8, zipSync } from 'fflate';

import { RepoSlug } from '../../models';
import { LocalGitProvider } from './local-provider';
import { LocalRepos } from './local-repos';
import { ZipRepos } from './zip-repos';

const slug: RepoSlug = { provider: 'local', owner: 'local', repo: 'rocket-main' };

function zipFile(entries: Record<string, string>, name = 'rocket-main.zip'): File {
  const payload: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(entries)) payload[path] = strToU8(text);
  const bytes = zipSync(payload);
  return new File([new Uint8Array(bytes)], name, { type: 'application/zip' });
}

describe('ZipRepos', () => {
  let zipRepos: ZipRepos;
  let provider: LocalGitProvider;

  beforeEach(() => {
    zipRepos = TestBed.inject(ZipRepos);
    provider = TestBed.inject(LocalGitProvider);
  });

  it('imports a source-only zip as a single synthetic commit', async () => {
    const name = await zipRepos.open(
      zipFile({
        'rocket-main/README.md': '# Rocket\n',
        'rocket-main/src/engine.ts': 'export const thrust = 1;\n',
        '__MACOSX/rocket-main/._README.md': 'junk',
      }),
    );

    expect(name).toBe('rocket-main');
    expect(TestBed.inject(LocalRepos).isConnected(name)).toBe(true);

    const metadata = await provider.getMetadata(slug);
    expect(metadata.defaultBranch).toBe('main');

    // The archive's single wrapper folder is stripped.
    const tree = await provider.getTree(slug, 'main');
    expect(tree.entries.map((e) => e.path).sort()).toEqual(['README.md', 'src', 'src/engine.ts']);

    const commits = await provider.listCommits(slug, {});
    expect(commits).toHaveLength(1);
    expect(commits[0].summary).toBe('Imported from rocket-main.zip');
    expect(commits[0].parentShas).toEqual([]);

    const file = await provider.getFileAtRef(slug, 'src/engine.ts', commits[0].sha);
    expect(file).toMatchObject({ kind: 'text', text: 'export const thrust = 1;\n' });
  });

  it('keeps files at the archive root when there is no single wrapper', async () => {
    const name = await zipRepos.open(zipFile({ 'a.txt': 'a\n', 'docs/b.txt': 'b\n' }, 'flat.zip'));

    const tree = await provider.getTree({ provider: 'local', owner: 'local', repo: name }, 'main');
    expect(tree.entries.map((e) => e.path).sort()).toEqual(['a.txt', 'docs', 'docs/b.txt']);
  });

  it('rejects archives without any files', async () => {
    await expect(zipRepos.open(zipFile({}, 'empty.zip'))).rejects.toThrow('contains no files');
  });
});
