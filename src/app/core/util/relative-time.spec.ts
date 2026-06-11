import { relativeTime, shortSha } from './relative-time';

describe('relativeTime', () => {
  const now = new Date('2026-06-11T12:00:00Z');

  it.each([
    ['2026-06-11T11:59:50Z', 'just now'],
    ['2026-06-11T11:58:00Z', '2 minutes ago'],
    ['2026-06-11T09:00:00Z', '3 hours ago'],
    ['2026-06-09T12:00:00Z', '2 days ago'],
    ['2026-05-28T12:00:00Z', '2 weeks ago'],
    ['2026-03-11T12:00:00Z', '3 months ago'],
    ['2020-06-11T12:00:00Z', '6 years ago'],
  ])('formats %s as %s', (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });

  it('clamps future timestamps to just now', () => {
    expect(relativeTime('2026-06-11T13:00:00Z', now)).toBe('just now');
  });

  it('returns an empty string for invalid input', () => {
    expect(relativeTime('not a date', now)).toBe('');
  });
});

describe('shortSha', () => {
  it('abbreviates to seven characters', () => {
    expect(shortSha('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')).toBe('a1b2c3d');
  });
});
