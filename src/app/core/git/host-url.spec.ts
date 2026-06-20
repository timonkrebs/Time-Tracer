import { instanceHostname, normalizeInstanceHost } from './host-url';

describe('normalizeInstanceHost', () => {
  it.each([
    ['https://git.example.com', 'https://git.example.com'],
    ['http://git.example.com', 'http://git.example.com'],
    // Scheme-less input is assumed https.
    ['git.example.com', 'https://git.example.com'],
    // A path, query, trailing slash or port collapse to the origin.
    ['https://git.example.com/owner/repo', 'https://git.example.com'],
    ['git.example.com/', 'https://git.example.com'],
    ['https://git.example.com:8443/x', 'https://git.example.com:8443'],
    ['  https://git.example.com  ', 'https://git.example.com'],
  ])('normalises %s to its origin', (input, expected) => {
    expect(normalizeInstanceHost(input)).toBe(expected);
  });

  it.each([
    // Dangerous / non-web schemes are rejected outright.
    ["javascript:alert('xss')", 'javascript: with no //'],
    ['javascript://alert(1)', 'javascript: with //'],
    ['data:text/html,<script>alert(1)</script>', 'data:'],
    ['file:///etc/passwd', 'file:'],
    ['ftp://example.com', 'ftp:'],
    ['vbscript:msgbox(1)', 'vbscript:'],
    // Empty / whitespace-only input has no origin.
    ['', 'empty'],
    ['   ', 'whitespace'],
  ])('rejects %s (%s)', (input) => {
    expect(normalizeInstanceHost(input)).toBeNull();
  });
});

describe('instanceHostname', () => {
  it('returns the lowercased hostname of a valid host', () => {
    expect(instanceHostname('https://Git.Example.com/x')).toBe('git.example.com');
    expect(instanceHostname('git.example.com')).toBe('git.example.com');
  });

  it('returns null for a dangerous scheme', () => {
    expect(instanceHostname("javascript:alert('xss')")).toBeNull();
  });
});
