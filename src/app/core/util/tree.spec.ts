import { TreeEntry } from '../models';
import { ancestorsOf, buildTree } from './tree';

function file(path: string): TreeEntry {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'file', sha: `sha-${path}` };
}

function dir(path: string): TreeEntry {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'dir', sha: `sha-${path}` };
}

describe('buildTree', () => {
  it('nests children under their directories', () => {
    const roots = buildTree([dir('src'), file('src/main.ts'), file('README.md')]);
    expect(roots.map((n) => n.path)).toEqual(['src', 'README.md']);
    expect(roots[0].children!.map((n) => n.path)).toEqual(['src/main.ts']);
  });

  it('sorts directories first, then case-insensitively by name', () => {
    const roots = buildTree([
      file('zebra.ts'),
      file('Alpha.ts'),
      dir('lib'),
      dir('Build'),
      file('beta.ts'),
    ]);
    expect(roots.map((n) => n.name)).toEqual(['Build', 'lib', 'Alpha.ts', 'beta.ts', 'zebra.ts']);
  });

  it('synthesises missing parent directories (truncated listings)', () => {
    const roots = buildTree([file('a/b/c.txt')]);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ path: 'a', kind: 'dir' });
    expect(roots[0].children![0]).toMatchObject({ path: 'a/b', kind: 'dir' });
    expect(roots[0].children![0].children![0]).toMatchObject({ path: 'a/b/c.txt', kind: 'file' });
  });

  it('upgrades a synthesised directory when the real entry arrives later', () => {
    const roots = buildTree([file('a/x.txt'), dir('a')]);
    expect(roots).toHaveLength(1);
    expect(roots[0].sha).toBe('sha-a');
    expect(roots[0].children!.map((n) => n.path)).toEqual(['a/x.txt']);
  });

  it('keeps submodules as leaves', () => {
    const roots = buildTree([
      { path: 'vendored', name: 'vendored', kind: 'submodule', sha: 'abc' },
    ]);
    expect(roots[0].kind).toBe('submodule');
    expect(roots[0].children).toBeUndefined();
  });

  it('handles an empty listing', () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe('ancestorsOf', () => {
  it('lists every ancestor directory', () => {
    expect(ancestorsOf('a/b/c.ts')).toEqual(['a', 'a/b']);
  });

  it('returns nothing for root-level paths', () => {
    expect(ancestorsOf('README.md')).toEqual([]);
  });
});
