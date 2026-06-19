import { busiestDay, longestStreak } from './wrapped';

describe('busiestDay', () => {
  it('finds the calendar day with the most commits', () => {
    expect(
      busiestDay([
        '2024-01-01T09:00:00Z',
        '2024-01-02T10:00:00Z',
        '2024-01-02T11:00:00Z',
        '2024-01-02T23:00:00Z',
        '2024-01-05T08:00:00Z',
      ]),
    ).toEqual({ date: '2024-01-02', count: 3 });
  });

  it('breaks ties on the earlier date', () => {
    expect(busiestDay(['2024-03-02T00:00:00Z', '2024-03-01T00:00:00Z'])).toEqual({
      date: '2024-03-01',
      count: 1,
    });
  });

  it('returns null for no dated commits', () => {
    expect(busiestDay([])).toBeNull();
    expect(busiestDay(['nope'])).toBeNull();
  });
});

describe('longestStreak', () => {
  it('finds the longest run of consecutive committing days', () => {
    expect(
      longestStreak([
        '2024-01-01T09:00:00Z',
        '2024-01-02T09:00:00Z', // streak of 2 starts
        '2024-01-04T09:00:00Z', // gap → new run
        '2024-01-05T09:00:00Z',
        '2024-01-06T09:00:00Z', // streak of 3 (4th–6th)
      ]),
    ).toEqual({ days: 3, start: '2024-01-04', end: '2024-01-06' });
  });

  it('collapses multiple commits on the same day', () => {
    expect(
      longestStreak(['2024-01-01T09:00:00Z', '2024-01-01T18:00:00Z', '2024-01-02T09:00:00Z']),
    ).toEqual({ days: 2, start: '2024-01-01', end: '2024-01-02' });
  });

  it('handles a single day and empty input', () => {
    expect(longestStreak(['2024-01-01T09:00:00Z'])).toEqual({
      days: 1,
      start: '2024-01-01',
      end: '2024-01-01',
    });
    expect(longestStreak([])).toBeNull();
  });
});
