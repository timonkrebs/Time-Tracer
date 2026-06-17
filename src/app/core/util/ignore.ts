/**
 * gitignore-style path matching, used to keep generated and vendored files out
 * of the Insights metrics (Hotspots, Coupling, Knowledge). Those files are
 * tracked in git — so they ride along in the commit walk — but nobody "owns"
 * `package-lock.json` or a `dist/` bundle as knowledge, and a build artifact
 * that changes on every commit would dominate the churn and coupling charts.
 *
 * {@link compileIgnore} turns a list of gitignore-style patterns into a matcher;
 * {@link isGeneratedFile} is that matcher pre-built from {@link DEFAULT_INSIGHTS_IGNORE},
 * a curated default set of commonly-generated paths.
 *
 * Supported syntax (a pragmatic subset of `.gitignore`): comments (`#`), blank
 * lines, a leading `/` to anchor to the root, a trailing `/` to match
 * directories only, `*` (within a path segment), `**` (across segments), `?`,
 * basename matching for slash-less patterns, and `!` negation (last match wins).
 */

interface Rule {
  readonly re: RegExp;
  readonly negated: boolean;
}

/** Escapes a single literal character for use inside a RegExp. */
function escapeChar(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Converts a glob body (no anchors/slashes stripped) to a RegExp fragment. */
function globToRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          out += '(?:.*/)?'; // `**/` — any number of leading segments
        } else {
          out += '.*'; // `**` — across segments
        }
      } else {
        out += '[^/]*'; // `*` — within a segment
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += escapeChar(c);
    }
  }
  return out;
}

/** Compiles one pattern line into a {@link Rule}, or null for comments/blanks. */
function compileRule(pattern: string): Rule | null {
  let p = pattern.trim();
  if (!p || p.startsWith('#')) return null;

  let negated = false;
  if (p.startsWith('!')) {
    negated = true;
    p = p.slice(1);
  }
  let dirOnly = false;
  if (p.endsWith('/')) {
    dirOnly = true;
    p = p.slice(0, -1);
  }
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  if (!p) return null;

  const hasSlash = p.includes('/');
  const body = globToRegex(p);

  // A slash-less, unanchored pattern matches a segment at any depth (gitignore's
  // basename rule); anything else is a path anchored to the root.
  const source =
    !hasSlash && !anchored
      ? `(?:^|/)${body}${dirOnly ? '/' : '(?:/|$)'}`
      : `^${body}${dirOnly ? '/' : '(?:/|$)'}`;

  return { re: new RegExp(source), negated };
}

/**
 * Builds a matcher from gitignore-style `patterns`. The returned predicate is
 * true when a (file) path is ignored. Rules are applied in order with
 * last-match-wins, so a later `!pattern` can re-include a path an earlier rule
 * excluded.
 */
export function compileIgnore(patterns: Iterable<string>): (path: string) => boolean {
  const rules: Rule[] = [];
  for (const pattern of patterns) {
    const rule = compileRule(pattern);
    if (rule) rules.push(rule);
  }
  return (path: string): boolean => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.re.test(path)) ignored = !rule.negated;
    }
    return ignored;
  };
}

/**
 * Curated default exclusions for the Insights metrics: dependencies/vendored
 * code, lockfiles, build output and minified/generated assets — the tracked
 * files that are generated rather than authored, so they only add noise to
 * churn, coupling and knowledge.
 */
export const DEFAULT_INSIGHTS_IGNORE: readonly string[] = [
  // Dependencies / vendored code
  'node_modules/',
  'bower_components/',
  'jspm_packages/',
  'vendor/',
  'Pods/',
  '.yarn/',
  // Lockfiles (most end in .lock; the rest are named explicitly)
  '*.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'go.sum',
  // Build / generated output. The common English-word dirs (build, out, obj,
  // target) are anchored to the repo root so they don't shadow authored source
  // directories like src/build or src/out; dist/ and coverage/ are distinctive
  // enough to match at any depth (e.g. a monorepo's packages/*/dist).
  'dist/',
  '/build/',
  '/out/',
  '/obj/',
  '/target/',
  'coverage/',
  '.next/',
  '.nuxt/',
  '.output/',
  '.svelte-kit/',
  '.angular/',
  '__pycache__/',
  // Minified / source maps / snapshots
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.snap',
];

/** Matches the curated {@link DEFAULT_INSIGHTS_IGNORE} default noise paths. */
export const isGeneratedFile = compileIgnore(DEFAULT_INSIGHTS_IGNORE);
