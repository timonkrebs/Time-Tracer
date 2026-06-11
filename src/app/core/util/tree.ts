import { TreeEntry, TreeNode } from '../models';

interface MutableNode extends TreeEntry {
  children?: MutableNode[];
}

/**
 * Builds a nested tree from the provider's flat entry list.
 *
 * Tolerates incomplete listings (e.g. truncated trees where a file appears
 * without its parent dir entry) by synthesising the missing directories.
 * Directories come first on every level, then files/submodules, each sorted
 * case-insensitively.
 */
export function buildTree(entries: readonly TreeEntry[]): TreeNode[] {
  const nodesByPath = new Map<string, MutableNode>();
  const roots: MutableNode[] = [];

  const attach = (node: MutableNode): void => {
    const parentPath = parentOf(node.path);
    if (parentPath === null) {
      roots.push(node);
      return;
    }
    ensureDir(parentPath).children!.push(node);
  };

  const ensureDir = (path: string): MutableNode => {
    const existing = nodesByPath.get(path);
    if (existing) {
      existing.children ??= [];
      return existing;
    }
    const dir: MutableNode = {
      path,
      name: nameOf(path),
      kind: 'dir',
      sha: '',
      children: [],
    };
    nodesByPath.set(path, dir);
    attach(dir);
    return dir;
  };

  for (const entry of entries) {
    const known = nodesByPath.get(entry.path);
    if (known) {
      // A synthesised dir gets replaced by the real entry's metadata.
      Object.assign(known, entry);
      continue;
    }
    const node: MutableNode = entry.kind === 'dir' ? { ...entry, children: [] } : { ...entry };
    nodesByPath.set(entry.path, node);
    attach(node);
  }

  sortLevel(roots);
  return roots;
}

function sortLevel(nodes: MutableNode[]): void {
  nodes.sort((a, b) => {
    const aDir = a.kind === 'dir' ? 0 : 1;
    const bDir = b.kind === 'dir' ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  for (const node of nodes) {
    if (node.children) sortLevel(node.children);
  }
}

function parentOf(path: string): string | null {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? null : path.slice(0, idx);
}

function nameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/** All ancestor directory paths of a path, e.g. `a/b/c.ts` → `['a', 'a/b']`. */
export function ancestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  let idx = path.indexOf('/');
  while (idx !== -1) {
    ancestors.push(path.slice(0, idx));
    idx = path.indexOf('/', idx + 1);
  }
  return ancestors;
}
