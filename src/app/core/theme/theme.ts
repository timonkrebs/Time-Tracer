import { Injectable, computed, effect, signal } from '@angular/core';

/** User's theme choice. `auto` follows the OS `prefers-color-scheme`. */
export type ThemePreference = 'auto' | 'light' | 'dark';
/** The concrete theme applied to the document once `auto` is resolved. */
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'time-tracer.theme';
/** Page background per theme — kept in sync with the no-flash script in index.html. */
const DARK_BG = '#09090b';
const LIGHT_BG = '#fafafa';
/** The order the toggle button cycles through. */
const CYCLE: readonly ThemePreference[] = ['auto', 'light', 'dark'];

/**
 * Drives the app's light/dark theme. The preference (`auto`/`light`/`dark`) is
 * persisted in localStorage; the *resolved* theme is written to a `data-theme`
 * attribute on `<html>`, which the stylesheet keys off to remap the neutral
 * colour ramp (see `styles.css`). In `auto` mode the OS preference is followed
 * live via a `matchMedia` listener.
 *
 * A tiny inline script in `index.html` applies the same resolution before first
 * paint, so there is no flash of the wrong theme; this service simply keeps the
 * document in sync afterwards and exposes the toggle.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _preference = signal<ThemePreference>(restorePreference());
  /** Whether the OS currently prefers dark — only consulted in `auto` mode. */
  private readonly _systemDark = signal(systemPrefersDark());

  readonly preference = this._preference.asReadonly();
  readonly resolved = computed<ResolvedTheme>(() => {
    const preference = this._preference();
    if (preference === 'light' || preference === 'dark') return preference;
    return this._systemDark() ? 'dark' : 'light';
  });

  constructor() {
    const media = systemDarkQuery();
    // Track OS changes so `auto` re-resolves live as the system theme flips.
    media?.addEventListener?.('change', (event) => this._systemDark.set(event.matches));
    // Apply the resolved theme to the document whenever it changes.
    effect(() => applyTheme(this.resolved()));
  }

  setPreference(preference: ThemePreference): void {
    this._preference.set(preference);
    persistPreference(preference);
  }

  /** Cycles auto → light → dark → auto — the toggle button's action. */
  cycle(): void {
    const next = CYCLE[(CYCLE.indexOf(this._preference()) + 1) % CYCLE.length];
    this.setPreference(next);
  }
}

/** The `prefers-color-scheme: dark` query, or null where unsupported (tests). */
function systemDarkQuery(): MediaQueryList | null {
  try {
    return typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  } catch {
    return null;
  }
}

function systemPrefersDark(): boolean {
  // Default to dark — the app's original, intended look — when undetectable.
  return systemDarkQuery()?.matches ?? true;
}

function restorePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'auto' || stored === 'light' || stored === 'dark') return stored;
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  return 'auto';
}

function persistPreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Best-effort only.
  }
}

/** Writes the resolved theme to `<html>` and the PWA address-bar colour. */
function applyTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.style.backgroundColor = theme === 'light' ? LIGHT_BG : DARK_BG;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'light' ? LIGHT_BG : DARK_BG);
}
