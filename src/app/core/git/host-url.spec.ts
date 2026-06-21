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
    // A scheme-less host:port keeps its port and is not mistaken for a scheme.
    ['git.example.com:8443', 'https://git.example.com:8443'],
    // Public IP literals are addresses too.
    ['https://203.0.113.10', 'https://203.0.113.10'],
    ['https://[2606:4700:4700::1111]', 'https://[2606:4700:4700::1111]'],
    // Userinfo (`user@host`, `user:pass@host`) is not the host: it collapses away
    // with the origin, so a blocked address smuggled into the userinfo can't
    // redirect a fetch away from the real, public host that follows the `@`.
    ['https://10.0.0.1@gitlab.com/owner/repo', 'https://gitlab.com'],
    ['https://user:pass@git.example.com', 'https://git.example.com'],
  ])('normalises %s to its origin', (input, expected) => {
    expect(normalizeInstanceHost(input)).toBe(expected);
  });

  it.each([
    // Dangerous / non-web schemes are rejected outright — whether written with
    // an authority (scheme://) or as an opaque scheme:path with one colon.
    ["javascript:alert('xss')", 'javascript: with no //'],
    ['javascript://alert(1)', 'javascript: with //'],
    ['data:text/html,<script>alert(1)</script>', 'data:'],
    ['file:///etc/passwd', 'file: with //'],
    ['file:/etc/passwd', 'file: single slash'],
    ['ftp://example.com', 'ftp:'],
    ['ssh:git@example.com', 'ssh: opaque'],
    ['mailto:admin@example.com', 'mailto:'],
    ['vbscript:msgbox(1)', 'vbscript:'],
    // Local, private-network and metadata addresses (SSRF targets) are blocked —
    // the host is fetched straight from the visitor's browser.
    ['http://localhost', 'localhost'],
    ['localhost:3000', 'localhost with port'],
    ['http://app.localhost', '.localhost subdomain'],
    ['http://127.0.0.1', 'loopback'],
    ['http://127.0.0.1:8080', 'loopback with port'],
    ['http://127.1', 'loopback shorthand'],
    ['http://2130706433', 'loopback as decimal'],
    ['http://0x7f.0.0.1', 'loopback as hex'],
    ['http://10.0.0.5', '10/8 private'],
    ['http://192.168.1.1', '192.168/16 private'],
    ['http://172.16.5.4', '172.16/12 private'],
    ['http://100.64.0.1', 'carrier-grade NAT'],
    ['http://169.254.169.254', 'cloud metadata'],
    ['http://0.0.0.0', 'unspecified'],
    ['http://[::1]', 'IPv6 loopback'],
    ['http://[::]', 'IPv6 unspecified'],
    ['http://[fc00::1]', 'IPv6 unique-local'],
    ['http://[fe80::1]', 'IPv6 link-local'],
    ['http://[::ffff:127.0.0.1]', 'IPv4-mapped loopback'],
    ['http://[::ffff:192.168.0.1]', 'IPv4-mapped private'],
    // The userinfo `@` parser-confusion trick: the real host is whatever follows
    // the last `@`, and that is what gets classified — a public-looking name
    // parked in the userinfo cannot mask a local/metadata target after it.
    ['https://gitlab.com@127.0.0.1', 'userinfo @ — loopback is the real host'],
    ['https://github.com@169.254.169.254/x', 'userinfo @ — metadata is the real host'],
    ['https://gitlab.com@[::1]/', 'userinfo @ — IPv6 loopback is the real host'],
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
