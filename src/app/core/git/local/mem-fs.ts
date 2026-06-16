import { FsLike, fsError, makeStats } from './fsa-fs';

/**
 * In-memory fs (read + write) — lets tests build real repositories with
 * isomorphic-git without touching a disk.
 */
export function createMemFs(): FsLike {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(['']);
  const norm = (p: string): string =>
    p
      .split('/')
      .filter((s) => s.length > 0 && s !== '.')
      .join('/');
  const parentOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')));
  const addParents = (p: string): void => {
    let dir = parentOf(p);
    while (dir && !dirs.has(dir)) {
      dirs.add(dir);
      dir = parentOf(dir);
    }
  };

  return {
    promises: {
      async readFile(path: string, options?: unknown) {
        const key = norm(path);
        const bytes = files.get(key);
        if (!bytes) throw fsError('ENOENT', key);
        const encoding =
          typeof options === 'string'
            ? options
            : ((options as { encoding?: string } | undefined)?.encoding ?? null);
        return encoding === 'utf8' ? new TextDecoder().decode(bytes) : bytes;
      },
      async writeFile(path: string, data: unknown) {
        const key = norm(path);
        addParents(key);
        files.set(
          key,
          typeof data === 'string'
            ? new TextEncoder().encode(data)
            : new Uint8Array(data as ArrayBuffer & Uint8Array),
        );
      },
      async readdir(path: string) {
        const key = norm(path);
        if (!dirs.has(key)) throw fsError('ENOENT', key);
        const names = new Set<string>();
        const prefix = key ? `${key}/` : '';
        for (const file of files.keys()) {
          if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split('/')[0]);
        }
        for (const dir of dirs) {
          if (dir && dir.startsWith(prefix) && dir !== key) {
            names.add(dir.slice(prefix.length).split('/')[0]);
          }
        }
        return [...names];
      },
      async stat(path: string) {
        const key = norm(path);
        const bytes = files.get(key);
        if (bytes) return makeStats('file', bytes.length, 0);
        if (dirs.has(key)) return makeStats('dir', 0, 0);
        throw fsError('ENOENT', key);
      },
      async lstat(path: string) {
        return this.stat(path);
      },
      async readlink(path: string): Promise<string> {
        throw fsError('ENOENT', path);
      },
      async mkdir(path: string) {
        const key = norm(path);
        if (dirs.has(key) || files.has(key)) throw fsError('EEXIST', key);
        addParents(key);
        dirs.add(key);
      },
      async rmdir(path: string) {
        dirs.delete(norm(path));
      },
      async unlink(path: string) {
        const key = norm(path);
        if (!files.delete(key)) throw fsError('ENOENT', key);
      },
      async rename(oldPath: string, newPath: string) {
        const from = norm(oldPath);
        const to = norm(newPath);
        const bytes = files.get(from);
        if (!bytes) throw fsError('ENOENT', from);
        files.delete(from);
        addParents(to);
        files.set(to, bytes);
      },
      async symlink(_target: string, path: string) {
        throw fsError('EROFS', path);
      },
    },
  };
}
