/**
 * Copies text to the clipboard, resolving `true` on success. Prefers the
 * async Clipboard API and falls back to a hidden `<textarea>` + `execCommand`
 * for browsers (or non-secure contexts) where it is unavailable.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or unavailable — fall back to the legacy path.
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  let area: HTMLTextAreaElement | null = null;
  try {
    area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    // Always remove the textarea, even if select()/execCommand threw.
    area?.parentNode?.removeChild(area);
  }
}
