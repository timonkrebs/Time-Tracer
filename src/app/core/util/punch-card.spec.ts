import { monthWeekday, punchCard, punchInsights, wallClockParts, yearMonth } from './punch-card';

describe('wallClockParts', () => {
  it('reads the year, month, weekday and hour from the wall clock', () => {
    // 2024-01-03 is a Wednesday (getUTCDay 3); January is month 0.
    expect(wallClockParts('2024-01-03T14:30:00Z')).toEqual({
      year: 2024,
      month: 0,
      day: 3,
      hour: 14,
    });
  });

  it('uses the written hour regardless of the offset', () => {
    expect(wallClockParts('2024-01-03T09:00:00+02:00')).toEqual({
      year: 2024,
      month: 0,
      day: 3,
      hour: 9,
    });
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

describe('punchInsights', () => {
  it('reports the peak slot, off-hours and weekend shares, and the active span', () => {
    const card = punchCard([
      '2024-01-03T14:00:00Z', // Wed 14 (business)
      '2024-01-03T14:00:00Z', // Wed 14 (business) — the peak
      '2024-01-01T10:00:00Z', // Mon 10 (business)
      '2024-01-06T02:00:00Z', // Sat 02 (after hours + weekend)
    ]);
    const insights = punchInsights(card);
    expect(insights.peakDay).toBe(3);
    expect(insights.peakHour).toBe(14);
    expect(insights.peakCount).toBe(2);
    expect(insights.afterHoursShare).toBe(0.25); // 1 of 4 outside 09:00–17:00
    expect(insights.weekendShare).toBe(0.25); // 1 of 4 on Saturday
    expect(insights.firstActiveHour).toBe(2);
    expect(insights.lastActiveHour).toBe(14);
  });

  it('is empty for no commits', () => {
    expect(punchInsights(punchCard([])).hasData).toBe(false);
  });
});

describe('yearMonth', () => {
  it('bins commits by year (newest first) and month', () => {
    const card = yearMonth([
      '2023-02-02T00:00:00Z', // Feb 2023
      '2024-01-03T00:00:00Z', // Jan 2024
      '2024-03-06T00:00:00Z', // Mar 2024
    ]);
    expect(card.years).toEqual([2024, 2023]);
    expect(card.byYear).toEqual([2, 1]);
    expect(card.grid[0]).toHaveLength(12);
    expect(card.grid[0][0]).toBe(1); // 2024 Jan
    expect(card.grid[0][2]).toBe(1); // 2024 Mar
    expect(card.grid[1][1]).toBe(1); // 2023 Feb
    expect(card.byMonth[0]).toBe(1); // one January
    expect(card.total).toBe(3);
    expect(card.max).toBe(1);
  });
});

describe('monthWeekday', () => {
  it('bins commits by month of the year and weekday', () => {
    const card = monthWeekday([
      '2024-01-03T00:00:00Z', // Jan, Wed
      '2023-01-01T00:00:00Z', // Jan, Sun (different year, same month)
      '2024-03-02T00:00:00Z', // Mar, Sat
    ]);
    expect(card.grid).toHaveLength(12);
    expect(card.byMonth[0]).toBe(2); // January across both years
    expect(card.byMonth[2]).toBe(1); // March
    expect(card.grid[0][3]).toBe(1); // Jan, Wed
    expect(card.grid[0][0]).toBe(1); // Jan, Sun
    expect(card.byWeekday[6]).toBe(1); // one Saturday
    expect(card.total).toBe(3);
    expect(card.max).toBe(1);
  });
});
