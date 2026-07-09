/**
 * Thin localStorage wrappers that swallow the errors thrown when storage is
 * unavailable (private mode, disabled cookies, quota exceeded) — so the many
 * small persistence helpers across the app don't each repeat the try/catch.
 * Reads degrade to null; writes and removes are best-effort no-ops.
 */

/** The stored string for `key`, or null when absent or storage is unavailable. */
export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Stores `value` under `key`; a no-op when storage is unavailable. */
export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Best-effort: storage may be unavailable (private mode, quota).
  }
}

/** Removes `key`; a no-op when storage is unavailable. */
export function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Best-effort.
  }
}
