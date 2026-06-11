/**
 * Read-only `fs.promises`-style adapter over a `FileSystemDirectoryHandle`
 * (File System Access API), shaped for isomorphic-git's reading operations.
 * Write operations reject with EROFS — Time Tracer never mutates a repo.
 */

export interface FsLike {
  readonly promises: {
    readFile(path: string, options?: unknown): Promise<Uint8Array | string>;
    readdir(path: string): Promise<string[]>;
    stat(path: string): Promise<FsStats>;
    lstat(path: string): Promise<FsStats>;
    readlink(path: string): Promise<string>;
    writeFile(path: string, data: unknown, options?: unknown): Promise<void>;
    mkdir(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    unlink(path: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    symlink(target: string, path: string): Promise<void>;
  };
}

export interface FsStats {
  type: 'file' | 'dir';
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  ino: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export function makeStats(type: 'file' | 'dir', size: number, mtimeMs: number): FsStats {
  return {
    type,
    mode: type === 'dir' ? 0o40755 : 0o100644,
    size,
    mtimeMs,
    ctimeMs: mtimeMs,
    uid: 1,
    gid: 1,
    dev: 1,
    ino: 1,
    isFile: () => type === 'file',
    isDirectory: () => type === 'dir',
    isSymbolicLink: () => false,
  };
}

export function fsError(code: 'ENOENT' | 'EROFS' | 'ENOTDIR' | 'EEXIST', path: string): Error {
  const error = new Error(`${code}: ${path}`) as Error & { code: string };
  error.code = code;
  return error;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0 && segment !== '.');
}

/** Wraps a directory handle as the read-only fs isomorphic-git reads from. */
export function createFsaFs(root: FileSystemDirectoryHandle): FsLike {
  const dirCache = new Map<string, FileSystemDirectoryHandle>([['', root]]);

  async function dirHandle(segments: string[]): Promise<FileSystemDirectoryHandle> {
    let handle = root;
    for (let i = 0; i < segments.length; i++) {
      const key = segments.slice(0, i + 1).join('/');
      const cached = dirCache.get(key);
      if (cached) {
        handle = cached;
        continue;
      }
      try {
        handle = await handle.getDirectoryHandle(segments[i]);
      } catch {
        throw fsError('ENOENT', segments.join('/'));
      }
      dirCache.set(key, handle);
    }
    return handle;
  }

  async function fileOf(path: string): Promise<File> {
    const segments = splitPath(path);
    const name = segments.pop();
    if (!name) throw fsError('ENOENT', path);
    const dir = await dirHandle(segments);
    try {
      const handle = await dir.getFileHandle(name);
      return await handle.getFile();
    } catch {
      throw fsError('ENOENT', path);
    }
  }

  const readOnly = (path: string): never => {
    throw fsError('EROFS', path);
  };

  return {
    promises: {
      async readFile(path: string, options?: unknown): Promise<Uint8Array | string> {
        const file = await fileOf(path);
        const bytes = new Uint8Array(await file.arrayBuffer());
        const encoding =
          typeof options === 'string'
            ? options
            : ((options as { encoding?: string } | undefined)?.encoding ?? null);
        return encoding === 'utf8' ? new TextDecoder().decode(bytes) : bytes;
      },
      async readdir(path: string): Promise<string[]> {
        const dir = await dirHandle(splitPath(path));
        const names: string[] = [];
        for await (const name of dir.keys()) names.push(name);
        return names;
      },
      async stat(path: string): Promise<FsStats> {
        const segments = splitPath(path);
        if (segments.length === 0) return makeStats('dir', 0, 0);
        try {
          const file = await fileOf(path);
          return makeStats('file', file.size, file.lastModified);
        } catch {
          await dirHandle(segments); // throws ENOENT when absent
          return makeStats('dir', 0, 0);
        }
      },
      lstat(path: string): Promise<FsStats> {
        return this.stat(path);
      },
      async readlink(path: string): Promise<string> {
        throw fsError('ENOENT', path);
      },
      async writeFile(path: string): Promise<void> {
        readOnly(path);
      },
      async mkdir(path: string): Promise<void> {
        readOnly(path);
      },
      async rmdir(path: string): Promise<void> {
        readOnly(path);
      },
      async unlink(path: string): Promise<void> {
        readOnly(path);
      },
      async rename(oldPath: string): Promise<void> {
        readOnly(oldPath);
      },
      async symlink(_target: string, path: string): Promise<void> {
        readOnly(path);
      },
    },
  };
}
