/**
 * Browser file downloads. Builds a Blob, points a transient `<a download>` at
 * it and clicks it, then revokes the object URL. Kept tiny and dependency-free,
 * the counterpart to {@link ./clipboard clipboard.ts} for "save" instead of
 * "copy".
 */

/** Triggers a download of `blob` under `filename`. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Revoke after the click has had a tick to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Downloads `text` as `filename` with the given MIME type. */
export function downloadText(filename: string, mime: string, text: string): void {
  downloadBlob(filename, new Blob([text], { type: mime }));
}
