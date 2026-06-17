import { DEFAULT_INSIGHTS_IGNORE, compileIgnore, isGeneratedFile } from './ignore';

describe('compileIgnore', () => {
  it('matches a directory pattern at any depth, but not lookalike names', () => {
    const ignored = compileIgnore(['node_modules/']);
    expect(ignored('node_modules/dep/index.js')).toBe(true);
    expect(ignored('packages/app/node_modules/dep.js')).toBe(true);
    // A trailing-slash pattern needs a real directory boundary.
    expect(ignored('src/node_modules_helper.ts')).toBe(false);
    expect(ignored('src/app.ts')).toBe(false);
  });

  it('matches a slash-less name as a basename at any depth', () => {
    const ignored = compileIgnore(['package-lock.json']);
    expect(ignored('package-lock.json')).toBe(true);
    expect(ignored('packages/web/package-lock.json')).toBe(true);
    expect(ignored('src/index.ts')).toBe(false);
  });

  it('supports * globs scoped to a single segment', () => {
    const ignored = compileIgnore(['*.min.js']);
    expect(ignored('vendor/jquery.min.js')).toBe(true);
    expect(ignored('app.js')).toBe(false);
    // The dot is literal, so "maps" must not match "*.map".
    const maps = compileIgnore(['*.map']);
    expect(maps('dist/app.css.map')).toBe(true);
    expect(maps('src/maps/region.ts')).toBe(false);
  });

  it('anchors patterns that start with / to the repository root', () => {
    const ignored = compileIgnore(['/build/']);
    expect(ignored('build/output.js')).toBe(true);
    expect(ignored('packages/app/build/output.js')).toBe(false);
  });

  it('spans path segments with ** ', () => {
    const ignored = compileIgnore(['a/**/b.ts']);
    expect(ignored('a/b.ts')).toBe(true);
    expect(ignored('a/x/y/b.ts')).toBe(true);
    expect(ignored('a/b.tsx')).toBe(false);
  });

  it('re-includes paths with ! negation (last match wins)', () => {
    const ignored = compileIgnore(['*.min.js', '!keep.min.js']);
    expect(ignored('a/app.min.js')).toBe(true);
    expect(ignored('keep.min.js')).toBe(false);
  });

  it('ignores comments and blank lines', () => {
    const ignored = compileIgnore(['# a comment', '', '   ', 'dist/']);
    expect(ignored('dist/a.js')).toBe(true);
    expect(ignored('src/a.ts')).toBe(false);
  });
});

describe('isGeneratedFile (default Insights exclusions)', () => {
  it('flags generated and vendored files', () => {
    for (const path of [
      'node_modules/left-pad/index.js',
      'yarn.lock',
      'Cargo.lock',
      'package-lock.json',
      'pnpm-lock.yaml',
      'go.sum',
      'dist/main.js',
      'packages/ui/dist/index.js',
      'coverage/lcov.info',
      // Root-level build output is still held out (just not nested src/* dirs).
      'build/main.js',
      'out/bundle.js',
      'obj/Debug/app.dll',
      'target/app.jar',
      'app/app.min.css',
      'src/__snapshots__/x.snap',
    ]) {
      expect(isGeneratedFile(path)).toBe(true);
    }
  });

  it('leaves authored source untouched', () => {
    for (const path of [
      'src/app/main.ts',
      'README.md',
      'core/util/ignore.ts',
      'lib/distance.ts', // not "dist/"
      'src/builder.ts', // not "build/"
      'src/bin/cli.ts', // authored CLI entrypoints live under bin/ too
      'packages/cli/bin/run.js',
      // build/out/obj/target are anchored to the root, so nested authored
      // directories with those names survive.
      'src/build/tool.ts',
      'src/out/adapter.ts',
      'src/obj/handler.ts',
      'src/target/spec.ts',
    ]) {
      expect(isGeneratedFile(path)).toBe(false);
    }
  });

  it('exposes its patterns for display/override', () => {
    expect(DEFAULT_INSIGHTS_IGNORE).toContain('node_modules/');
    expect(DEFAULT_INSIGHTS_IGNORE.length).toBeGreaterThan(0);
  });
});
