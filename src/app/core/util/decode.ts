/** Byte-level helpers for turning provider blob payloads into displayable text. */

/** Decodes a base64 string (tolerating embedded whitespace/newlines) into bytes. */
export function base64ToBytes(base64: string): Uint8Array {
  const cleaned = base64.replace(/\s/g, '');
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Same heuristic git itself uses: treat content as binary when a NUL byte
 * appears in the first 8000 bytes.
 */
export function isProbablyBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/** Decodes bytes as UTF-8, replacing invalid sequences instead of throwing. */
export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
