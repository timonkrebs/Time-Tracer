import { createFsaFs } from './fsa-fs';

/**
 * Fake File System Access handles with call counters, so the specs can pin
 * the session caches: loose-object bytes, `.git/objects` listings and
 * negative lookups must be served without another round trip, while
 * working-tree paths keep hitting the (mutable) real file system.
 */

const domError = (name: string): Error => Object.assign(new Error(name), { name });

class FakeFileHandle {
  getFileCalls = 0;
  constructor(private readonly bytes: Uint8Array) {}

  async getFile(): Promise<File> {
    this.getFileCalls++;
    const bytes = this.bytes;
    return {
      size: bytes.length,
      lastModified: 42,
      arrayBuffer: async () => bytes.buffer.slice(0),
    } as unknown as File;
  }
}

class FakeDirHandle {
  readonly children = new Map<string, FakeDirHandle | FakeFileHandle>();
  dirLookups = 0;
  fileLookups = 0;
  listings = 0;

  async getDirectoryHandle(name: string): Promise<FakeDirHandle> {
    this.dirLookups++;
    const entry = this.children.get(name);
    if (!entry) throw domError('NotFoundError');
    if (!(entry instanceof FakeDirHandle)) throw domError('TypeMismatchError');
    return entry;
  }

  async getFileHandle(name: string): Promise<FakeFileHandle> {
    this.fileLookups++;
    const entry = this.children.get(name);
    if (!entry) throw domError('NotFoundError');
    if (!(entry instanceof FakeFileHandle)) throw domError('TypeMismatchError');
    return entry;
  }

  async *keys(): AsyncIterableIterator<string> {
    this.listings++;
    yield* this.children.keys();
  }
}

interface TreeSpec {
  [name: string]: TreeSpec | string;
}

function makeTree(spec: TreeSpec): FakeDirHandle {
  const dir = new FakeDirHandle();
  for (const [name, value] of Object.entries(spec)) {
    dir.children.set(
      name,
      typeof value === 'string'
        ? new FakeFileHandle(new TextEncoder().encode(value))
        : makeTree(value),
    );
  }
  return dir;
}

describe('createFsaFs', () => {
  let root: FakeDirHandle;
  let fs: ReturnType<typeof createFsaFs>;

  const dir = (path: string): FakeDirHandle => {
    let handle: FakeDirHandle | FakeFileHandle = root;
    for (const segment of path.split('/')) {
      handle = (handle as FakeDirHandle).children.get(segment)!;
    }
    return handle as FakeDirHandle;
  };
  const file = (path: string): FakeFileHandle => {
    const segments = path.split('/');
    const name = segments.pop()!;
    const parent = segments.length > 0 ? dir(segments.join('/')) : root;
    return parent.children.get(name) as FakeFileHandle;
  };

  beforeEach(() => {
    root = makeTree({
      '.git': {
        objects: {
          aa: { bbccdd: 'loose object payload' },
          pack: { 'pack-1.idx': 'idx bytes', 'pack-1.pack': 'pack bytes' },
        },
      },
      src: { 'a.ts': 'alpha' },
      'readme.md': 'hello',
    });
    fs = createFsaFs(root as unknown as FileSystemDirectoryHandle);
  });

  it('reads files as bytes, or as text with the utf8 encoding', async () => {
    const bytes = (await fs.promises.readFile('/readme.md')) as Uint8Array;
    expect(new TextDecoder().decode(bytes)).toBe('hello');
    expect(await fs.promises.readFile('/readme.md', 'utf8')).toBe('hello');
    expect(await fs.promises.readFile('/src/a.ts', { encoding: 'utf8' })).toBe('alpha');
  });

  it('lists directories and stats files, dirs and the root', async () => {
    expect((await fs.promises.readdir('/src')).sort()).toEqual(['a.ts']);
    expect((await fs.promises.stat('/readme.md')).isFile()).toBe(true);
    expect((await fs.promises.stat('/readme.md')).size).toBe(5);
    expect((await fs.promises.stat('/src')).isDirectory()).toBe(true);
    expect((await fs.promises.stat('/')).isDirectory()).toBe(true);
    await expect(fs.promises.stat('/nope')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects every write with EROFS', async () => {
    await expect(fs.promises.writeFile('/x', 'y')).rejects.toMatchObject({ code: 'EROFS' });
    await expect(fs.promises.mkdir('/d')).rejects.toMatchObject({ code: 'EROFS' });
    await expect(fs.promises.unlink('/readme.md')).rejects.toMatchObject({ code: 'EROFS' });
  });

  it('serves repeated loose-object reads from the byte cache', async () => {
    const first = (await fs.promises.readFile('/.git/objects/aa/bbccdd')) as Uint8Array;
    const second = (await fs.promises.readFile('/.git/objects/aa/bbccdd')) as Uint8Array;
    expect(new TextDecoder().decode(second)).toBe('loose object payload');
    expect(second).toEqual(first);
    // One handle lookup and one payload fetch — the second read is memory only.
    expect(dir('.git/objects/aa').fileLookups).toBe(1);
    expect(file('.git/objects/aa/bbccdd').getFileCalls).toBe(1);
  });

  it('does not byte-cache working-tree files (they are not content-addressed)', async () => {
    await fs.promises.readFile('/readme.md');
    await fs.promises.readFile('/readme.md');
    expect(file('readme.md').getFileCalls).toBe(2);
  });

  it('does not byte-cache pack-directory files (isomorphic-git caches those itself)', async () => {
    await fs.promises.readFile('/.git/objects/pack/pack-1.idx');
    await fs.promises.readFile('/.git/objects/pack/pack-1.idx');
    expect(file('.git/objects/pack/pack-1.idx').getFileCalls).toBe(2);
  });

  it('caches object-store listings but re-lists working-tree directories', async () => {
    await fs.promises.readdir('/.git/objects/pack');
    const names = await fs.promises.readdir('/.git/objects/pack');
    expect(names.sort()).toEqual(['pack-1.idx', 'pack-1.pack']);
    expect(dir('.git/objects/pack').listings).toBe(1);

    await fs.promises.readdir('/src');
    await fs.promises.readdir('/src');
    expect(dir('src').listings).toBe(2);
  });

  it('negative-caches missing object-store lookups (the per-object loose probe)', async () => {
    // A fan-out directory that does not exist: probed once, then remembered.
    await expect(fs.promises.readFile('/.git/objects/ff/0011')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.promises.readFile('/.git/objects/ff/0011')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(dir('.git/objects').dirLookups).toBe(1);

    // A missing file inside an existing fan-out directory: probed once too.
    await expect(fs.promises.readFile('/.git/objects/aa/nope')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.promises.readFile('/.git/objects/aa/nope')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(dir('.git/objects/aa').fileLookups).toBe(1);
  });

  it('keeps retrying missing working-tree paths (no negative cache outside .git/objects)', async () => {
    await expect(fs.promises.readFile('/missing.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.readFile('/missing.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(root.fileLookups).toBe(2);
  });

  it('does not mark an object-store directory missing when probed as a file', async () => {
    // `stat` probes the file shape first — a TypeMismatch must not poison the
    // directory for later reads.
    expect((await fs.promises.stat('/.git/objects/aa')).isDirectory()).toBe(true);
    const bytes = (await fs.promises.readFile('/.git/objects/aa/bbccdd')) as Uint8Array;
    expect(new TextDecoder().decode(bytes)).toBe('loose object payload');
  });
});
