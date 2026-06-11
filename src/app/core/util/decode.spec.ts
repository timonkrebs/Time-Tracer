import { base64ToBytes, bytesToUtf8, isProbablyBinary } from './decode';

describe('base64ToBytes', () => {
  it('decodes plain base64', () => {
    expect(bytesToUtf8(base64ToBytes('aGVsbG8='))).toBe('hello');
  });

  it('tolerates embedded newlines (GitHub blob format)', () => {
    expect(bytesToUtf8(base64ToBytes('aGVs\nbG8=\n'))).toBe('hello');
  });
});

describe('isProbablyBinary', () => {
  it('flags content with a NUL byte', () => {
    expect(isProbablyBinary(new Uint8Array([0x50, 0x4b, 0x00, 0x04]))).toBe(true);
  });

  it('accepts plain text', () => {
    expect(isProbablyBinary(new TextEncoder().encode('const x = 1;\n'))).toBe(false);
  });

  it('only inspects the first 8000 bytes', () => {
    const bytes = new Uint8Array(9000).fill(0x61);
    bytes[8500] = 0;
    expect(isProbablyBinary(bytes)).toBe(false);
  });
});

describe('bytesToUtf8', () => {
  it('round-trips multibyte characters', () => {
    const text = 'grüße ✓ 🙂';
    expect(bytesToUtf8(new TextEncoder().encode(text))).toBe(text);
  });

  it('replaces invalid sequences instead of throwing', () => {
    expect(bytesToUtf8(new Uint8Array([0xff, 0xfe, 0x61]))).toContain('a');
  });
});
