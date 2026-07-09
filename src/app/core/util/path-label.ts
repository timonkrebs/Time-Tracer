/**
 * Display labels for a set of file paths: each path's basename when that name
 * is unique within the set, or the full path when another file shares the same
 * basename — so same-named files (two `index.ts`, etc.) stay distinguishable.
 */
export function disambiguateLabels(paths: Iterable<string>): Map<string, string> {
  const unique = [...new Set(paths)];
  const counts = new Map<string, number>();
  for (const path of unique) {
    const base = basename(path);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const path of unique) {
    const base = basename(path);
    labels.set(path, (counts.get(base) ?? 0) > 1 ? path : base);
  }
  return labels;
}

/** The last path segment (file or folder name), or the whole path if it has no `/`. */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}
