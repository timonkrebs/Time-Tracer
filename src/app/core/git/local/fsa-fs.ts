/**
 * Read-only `fs.promises`-style adapter over a `FileSystemDirectoryHandle`
 * (File System Access API), shaped for isomorphic-git's reading operations.
 * Write operations reject with EROFS — Time Tracer never mutates a repo.
 *
 * `.git/objects/` is treated as immutable for the session (it is
 * content-addressed, and the repo is read-only while open), which unlocks the
 * caching isomorphic-git itself never does: every object read it performs
 * first probes the loose-object path and then re-lists `objects/pack` — two
 * File System Access round trips per object, per read — and loose objects are
 * re-fetched and re-inflated on every access because the library has no
 * oid-level object cache. The listing cache, the negative lookup cache and the
 * bounded loose-object byte cache below remove exactly those round trips.
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

/** The content-addressed object store — immutable while the repo is open. */
const OBJECTS_DIR = '.git/objects';
/** Loose objects above this size are not kept in the byte cache. */
const LOOSE_CACHE_MAX_FILE = 1_048_576; // 1 MB
/** Total byte budget of the loose-object cache (oldest evicted first). */
const LOOSE_CACHE_BUDGET = 64 * 1_048_576; // 64 MB

/** Whether a normalised key lies in the object store (cacheable for the session). */
function inObjectStore(key: string): boolean {
  return key === OBJECTS_DIR || key.startsWith(`${OBJECTS_DIR}/`);
}

/** Only a genuine "no such entry" may be cached — a directory hit as a file
 * (TypeMismatchError) or a revoked permission must stay uncached. */
function isNotFound(error: unknown): boolean {
  return (error as { name?: string }).name === 'NotFoundError';
}

/** Wraps a directory handle as the read-only fs isomorphic-git reads from. */
export function createFsaFs(root: FileSystemDirectoryHandle): FsLike {
  const dirCache = new Map<string, FileSystemDirectoryHandle>([['', root]]);
  /** Object-store paths known to be absent — isomorphic-git probes the loose
   * path of every object before touching a packfile, so on packed repos this
   * saves one failed FS round trip per object read. */
  const missingObjectPaths = new Set<string>();
  /** Object-store directory listings — isomorphic-git re-lists `objects/pack`
   * on every packed-object read. */
  const objectListings = new Map<string, string[]>();
  /** Loose object bytes, LRU by re-insertion, capped by {@link LOOSE_CACHE_BUDGET}.
   * Callers never mutate read buffers (isomorphic-git inflates into new arrays),
   * so handing out the same instance is safe. */
  const looseBytes = new Map<string, Uint8Array>();
  let looseBytesTotal = 0;

  async function dirHandle(segments: string[]): Promise<FileSystemDirectoryHandle> {
    let handle = root;
    for (let i = 0; i < segments.length; i++) {
      const key = segments.slice(0, i + 1).join('/');
      const cached = dirCache.get(key);
      if (cached) {
        handle = cached;
        continue;
      }
      if (missingObjectPaths.has(key)) throw fsError('ENOENT', segments.join('/'));
      try {
        handle = await handle.getDirectoryHandle(segments[i]);
      } catch (error) {
        if (inObjectStore(key) && isNotFound(error)) missingObjectPaths.add(key);
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
    const key = segments.length > 0 ? `${segments.join('/')}/${name}` : name;
    if (missingObjectPaths.has(key)) throw fsError('ENOENT', path);
    const dir = await dirHandle(segments);
    try {
      const handle = await dir.getFileHandle(name);
      return await handle.getFile();
    } catch (error) {
      if (inObjectStore(key) && isNotFound(error)) missingObjectPaths.add(key);
      throw fsError('ENOENT', path);
    }
  }

  /** Caches loose-object payloads; packfiles (and their .idx, which
   * isomorphic-git caches itself) sit above the per-file cap and stay out. */
  function cacheLoose(key: string, bytes: Uint8Array): void {
    if (bytes.length > LOOSE_CACHE_MAX_FILE) return;
    looseBytes.set(key, bytes);
    looseBytesTotal += bytes.length;
    while (looseBytesTotal > LOOSE_CACHE_BUDGET) {
      const oldest: string = looseBytes.keys().next().value!;
      looseBytesTotal -= looseBytes.get(oldest)!.length;
      looseBytes.delete(oldest);
    }
  }

  const readOnly = (path: string): never => {
    throw fsError('EROFS', path);
  };

  return {
    promises: {
      async readFile(path: string, options?: unknown): Promise<Uint8Array | string> {
        const key = splitPath(path).join('/');
        const encoding =
          typeof options === 'string'
            ? options
            : ((options as { encoding?: string } | undefined)?.encoding ?? null);
        let bytes = looseBytes.get(key);
        if (bytes) {
          // LRU touch: re-insertion moves the entry to the young end.
          looseBytes.delete(key);
          looseBytes.set(key, bytes);
        } else {
          const file = await fileOf(path);
          bytes = new Uint8Array(await file.arrayBuffer());
          if (inObjectStore(key)) cacheLoose(key, bytes);
        }
        return encoding === 'utf8' ? new TextDecoder().decode(bytes) : bytes;
      },
      async readdir(path: string): Promise<string[]> {
        const key = splitPath(path).join('/');
        let names = objectListings.get(key);
        if (!names) {
          const dir = await dirHandle(splitPath(path));
          names = [];
          for await (const name of dir.keys()) names.push(name);
          if (inObjectStore(key)) objectListings.set(key, names);
        }
        return [...names];
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
