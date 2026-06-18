import { punchCard, wallClockParts } from './punch-card';

describe('wallClockParts', () => {
  it('reads the weekday and hour from the wall clock', () => {
    // 2024-01-03 is a Wednesday (getUTCDay 3).
    expect(wallClockParts('2024-01-03T14:30:00Z')).toEqual({ day: 3, hour: 14 });
  });

  it('uses the written hour regardless of the offset', () => {
    expect(wallClockParts('2024-01-03T09:00:00+02:00')).toEqual({ day: 3, hour: 9 });
  });

  it('returns null for unparseable input', () => {
    expect(wallClockParts('nope')).toBeNull();
    expect(wallClockParts('')).toBeNull();
  });
});

describe('punchCard', () => {
  it('bins commits by weekday and hour with marginals', () => {
    const card = punchCard([
      '2024-01-03T14:00:00Z', // Wed 14:00
      '2024-01-03T14:20:00Z', // Wed 14:00
      '2024-01-01T09:00:00Z', // Mon 09:00
    ]);
    expect(card.total).toBe(3);
    expect(card.grid[3][14]).toBe(2);
    expect(card.grid[1][9]).toBe(1);
    expect(card.max).toBe(2);
    expect(card.byDay[3]).toBe(2);
    expect(card.byHour[14]).toBe(2);
  });

  it('skips unparseable timestamps', () => {
    expect(punchCard(['', 'bad', '2024-01-01T00:00:00Z']).total).toBe(1);
  });

  it('is an empty 7×24 grid for no commits', () => {
    const card = punchCard([]);
    expect(card.total).toBe(0);
    expect(card.max).toBe(0);
    expect(card.grid).toHaveLength(7);
    expect(card.grid[0]).toHaveLength(24);
  });
});
