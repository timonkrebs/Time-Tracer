import { computeKnowledgeRisk } from './knowledge';
import { busFactorBoard, simulateDeparture } from './bus-factor';

// A small project where one file rests on a single active expert (Ada), one is
// co-owned (Ada + Cy), and one was last touched years ago (Bo — already gone).
const NOW = Date.parse('2024-01-10T00:00:00Z');
const RECENT = '2024-01-08T00:00:00Z';
const OLD = '2018-01-01T00:00:00Z';
const SIZES = new Map([
  ['a.ts', 100],
  ['b.ts', 100],
  ['c.ts', 100],
]);

function model() {
  return computeKnowledgeRisk(
    [
      { authorName: 'Ada', authoredAt: RECENT, files: ['a.ts'] },
      { authorName: 'Ada', authoredAt: RECENT, files: ['c.ts'] },
      { authorName: 'Cy', authoredAt: RECENT, files: ['c.ts'] },
      { authorName: 'Bo', authoredAt: OLD, files: ['b.ts'] },
    ],
    SIZES,
    { now: NOW },
  );
}

describe('simulateDeparture', () => {
  it('counts files already orphaned when no one has left', () => {
    const impact = simulateDeparture(model(), new Set());
    expect(impact.filesWithExperts).toBe(3);
    expect(impact.alreadyOrphaned).toBe(1); // b.ts — only an inactive expert
    expect(impact.newlyOrphaned).toBe(0);
  });

  it('orphans a file whose only active expert leaves', () => {
    const impact = simulateDeparture(model(), new Set(['Ada']));
    expect(impact.newlyOrphaned).toBe(1);
    expect(impact.newlyOrphanedPaths).toContain('a.ts'); // c.ts still has Cy
    expect(impact.orphanedAfter).toBe(2); // a.ts (new) + b.ts (already)
  });
});

describe('busFactorBoard', () => {
  it('ranks contributors by bus risk and reports their owned files', () => {
    const board = busFactorBoard(model());
    const byName = new Map(board.map((c) => [c.name, c]));

    expect(board[0].name).toBe('Ada'); // highest bus risk first
    expect(byName.get('Ada')?.busRisk).toBe(1);
    expect(byName.get('Cy')?.busRisk).toBe(0); // c.ts also held by Ada
    expect(byName.get('Bo')?.busRisk).toBe(0); // b.ts is already orphaned
    expect(byName.get('Bo')?.active).toBe(false);
  });
});
