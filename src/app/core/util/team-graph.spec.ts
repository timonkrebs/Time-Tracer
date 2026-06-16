import { AuthoredCommit, blendStrength, collaboratorsOf, computeTeamGraph } from './team-graph';

/** ISO timestamp for day N of 2026, for legible temporal fixtures. */
const day = (n: number): string => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();

const COMMITS: AuthoredCommit[] = [
  { authorName: 'Ada', files: ['auth.ts', 'session.ts'] },
  { authorName: 'Bo', files: ['auth.ts', 'session.ts'] },
  { authorName: 'Ada', files: ['auth.ts'] },
  { authorName: 'Cy', files: ['db.ts'] },
  { authorName: 'Cy', files: ['db.ts', 'schema.ts'] },
];

describe('computeTeamGraph', () => {
  it('counts each developer’s commits and distinct files', () => {
    const graph = computeTeamGraph(COMMITS);
    const byName = new Map(graph.developers.map((d) => [d.name, d]));

    expect(graph.developers.map((d) => d.name)).toEqual(['Ada', 'Cy', 'Bo']); // commits desc
    expect(byName.get('Ada')).toMatchObject({ commits: 2, files: 2, collaborators: 1 });
    expect(byName.get('Bo')).toMatchObject({ commits: 1, files: 2, collaborators: 1 });
    expect(byName.get('Cy')).toMatchObject({ commits: 2, files: 2, collaborators: 0 });
  });

  it('ties developers by shared files, scored by Jaccard overlap', () => {
    const graph = computeTeamGraph(COMMITS);

    // Ada and Bo both touched auth.ts and session.ts (2 shared); their union of
    // files is also {auth, session} → strength 1. Cy shares nothing. With no
    // dates on these commits the temporal strength is 0.
    expect(graph.collaborations).toEqual([
      { a: 'Ada', b: 'Bo', sharedFiles: 2, strength: 1, temporalStrength: 0 },
    ]);
  });

  it('reports a partial-overlap strength below 1', () => {
    // Ada: {a, b}; Bo: {b, c}. Shared {b} = 1; union {a, b, c} = 3 → 1/3.
    const graph = computeTeamGraph([
      { authorName: 'Ada', files: ['a', 'b'] },
      { authorName: 'Bo', files: ['b', 'c'] },
    ]);
    expect(graph.collaborations[0]).toMatchObject({ a: 'Ada', b: 'Bo', sharedFiles: 1 });
    expect(graph.collaborations[0].strength).toBeCloseTo(1 / 3, 10);
  });

  it('groups developers into connected components and flags silos', () => {
    const graph = computeTeamGraph(COMMITS);

    // Ada–Bo are joined by shared files; Cy stands alone.
    expect(graph.components).toEqual([['Ada', 'Bo'], ['Cy']]);
    expect(graph.silos).toEqual(['Cy']);
  });

  it('merges a bridge developer’s two groups into one component', () => {
    // Bridge touches a file from each side, linking the otherwise separate pairs.
    const graph = computeTeamGraph([
      { authorName: 'Ada', files: ['x'] },
      { authorName: 'Bo', files: ['x'] },
      { authorName: 'Cy', files: ['y'] },
      { authorName: 'Di', files: ['y'] },
      { authorName: 'Bridge', files: ['x', 'y'] },
    ]);
    expect(graph.components).toHaveLength(1);
    expect(graph.components[0]).toEqual(['Ada', 'Bo', 'Bridge', 'Cy', 'Di']);
    expect(graph.silos).toEqual([]);
  });

  it('drops sweeping commits that would couple the whole team', () => {
    const graph = computeTeamGraph(
      [
        { authorName: 'Ada', files: ['a', 'b', 'c'] }, // a 3-file sweep, dropped
        { authorName: 'Bo', files: ['a', 'b'] },
        { authorName: 'Cy', files: ['a', 'b'] },
      ],
      { maxCommitFiles: 2 },
    );
    // Ada's sweep is ignored, so Ada has no files and ties to no one.
    expect(graph.developers.map((d) => d.name).sort()).toEqual(['Bo', 'Cy']);
    expect(graph.collaborations).toEqual([
      { a: 'Bo', b: 'Cy', sharedFiles: 2, strength: 1, temporalStrength: 0 },
    ]);
  });

  it('honours a higher minimum shared-files threshold', () => {
    const graph = computeTeamGraph(COMMITS, { minShared: 3 });
    // Ada↔Bo share only 2 files (< 3), so no tie survives.
    expect(graph.collaborations).toEqual([]);
    expect(graph.silos).toEqual(['Ada', 'Cy', 'Bo']);
  });

  it('ignores commits with no author', () => {
    const graph = computeTeamGraph([
      { authorName: '', files: ['a'] },
      { authorName: '  ', files: ['a'] },
      { authorName: 'Ada', files: ['a'] },
    ]);
    expect(graph.developers.map((d) => d.name)).toEqual(['Ada']);
  });

  it('returns the empty graph for no commits', () => {
    const graph = computeTeamGraph([]);
    expect(graph.developers).toEqual([]);
    expect(graph.collaborations).toEqual([]);
    expect(graph.components).toEqual([]);
    expect(graph.silos).toEqual([]);
  });

  it('keys developers by email — merging names and splitting a shared name', () => {
    const graph = computeTeamGraph([
      // One person, two display names, same email (different case) → one node.
      { authorName: 'Tim', authorEmail: 'tim@x.io', files: ['a.ts'] },
      { authorName: 'Timon', authorEmail: 'Tim@X.io', files: ['b.ts'] },
      // Two different people sharing a display name but distinct emails → two nodes.
      { authorName: 'Sam', authorEmail: 'sam1@x.io', files: ['a.ts'] },
      { authorName: 'Sam', authorEmail: 'sam2@x.io', files: ['b.ts'] },
    ]);

    // Tim/Timon fold into a single identity, their files merged.
    const tim = graph.developers.find((d) => d.id === 'tim@x.io');
    expect(tim).toMatchObject({ commits: 2, files: 2 });
    // The two Sams stay distinct identities despite the shared display name.
    const sams = graph.developers.filter((d) => d.name === 'Sam').map((d) => d.id);
    expect(sams.sort()).toEqual(['sam1@x.io', 'sam2@x.io']);
  });

  it('falls back to the name when an author has no email', () => {
    const graph = computeTeamGraph([
      { authorName: 'Ada', authorEmail: null, files: ['a.ts'] },
      { authorName: 'Ada', files: ['b.ts'] },
    ]);
    expect(graph.developers).toEqual([
      { id: 'Ada', name: 'Ada', commits: 2, files: 2, collaborators: 0 },
    ]);
  });

  it('weights a recent tight handoff above a recent loose one (proximity)', () => {
    const graph = computeTeamGraph(
      [
        // Ada & Bo edit f1 at the same moment, at the tip.
        { authorName: 'Ada', authorEmail: 'ada@x', authoredAt: day(400), files: ['f1.ts'] },
        { authorName: 'Bo', authorEmail: 'bo@x', authoredAt: day(400), files: ['f1.ts'] },
        // Ada & Cy edit f2 a month apart, but the later edit is also at the tip.
        { authorName: 'Ada', authorEmail: 'ada@x', authoredAt: day(370), files: ['f2.ts'] },
        { authorName: 'Cy', authorEmail: 'cy@x', authoredAt: day(400), files: ['f2.ts'] },
      ],
      { proximityHalfLifeDays: 30 },
    );
    const adaBo = graph.collaborations.find((e) => e.a === 'ada@x' && e.b === 'bo@x')!;
    const adaCy = graph.collaborations.find((e) => e.a === 'ada@x' && e.b === 'cy@x')!;
    // Both land at the tip (age 0), so only the gap separates them.
    expect(adaBo.temporalStrength).toBeGreaterThan(adaCy.temporalStrength);
    expect(adaBo.temporalStrength).toBeLessThanOrEqual(adaBo.strength);
  });

  it('fades a tie as its handoff ages, even when the edits were simultaneous', () => {
    const graph = computeTeamGraph([
      // An old, same-moment handoff…
      { authorName: 'Ada', authorEmail: 'ada@x', authoredAt: day(0), files: ['old.ts'] },
      { authorName: 'Bo', authorEmail: 'bo@x', authoredAt: day(0), files: ['old.ts'] },
      // …and a current one at the tip (defines "now" for the age decay).
      { authorName: 'Cy', authorEmail: 'cy@x', authoredAt: day(400), files: ['new.ts'] },
      { authorName: 'Di', authorEmail: 'di@x', authoredAt: day(400), files: ['new.ts'] },
    ]);
    const adaBo = graph.collaborations.find((e) => e.a === 'ada@x' && e.b === 'bo@x')!;
    const cyDi = graph.collaborations.find((e) => e.a === 'cy@x' && e.b === 'di@x')!;
    // Identical all-time strength and gap (0), but the ~400-day-old tie fades.
    expect(adaBo.strength).toBeCloseTo(cyDi.strength, 10);
    expect(cyDi.temporalStrength).toBeGreaterThan(0.9);
    expect(adaBo.temporalStrength).toBeLessThan(0.1);
  });
});

describe('blendStrength', () => {
  it('interpolates from all-time at weight 0 to temporal at weight 1', () => {
    expect(blendStrength(0.8, 0.2, 0)).toBeCloseTo(0.8);
    expect(blendStrength(0.8, 0.2, 1)).toBeCloseTo(0.2);
    expect(blendStrength(0.8, 0.2, 0.5)).toBeCloseTo(0.5);
  });
});

describe('collaboratorsOf', () => {
  it('lists a developer’s collaborators, most shared files first', () => {
    const graph = computeTeamGraph([
      { authorName: 'Ada', files: ['a', 'b', 'c'] },
      { authorName: 'Bo', files: ['a', 'b'] }, // shares 2 with Ada
      { authorName: 'Cy', files: ['c'] }, // shares 1 with Ada
    ]);
    expect(collaboratorsOf(graph, 'Ada')).toEqual([
      { id: 'Bo', name: 'Bo', sharedFiles: 2, strength: 2 / 3, temporalStrength: 0 },
      { id: 'Cy', name: 'Cy', sharedFiles: 1, strength: 1 / 3, temporalStrength: 0 },
    ]);
  });

  it('honours the limit and returns nothing for an isolated or unknown developer', () => {
    const graph = computeTeamGraph(COMMITS);
    expect(collaboratorsOf(graph, 'Ada', 0)).toEqual([]);
    expect(collaboratorsOf(graph, 'Cy')).toEqual([]); // a silo
    expect(collaboratorsOf(graph, 'nobody')).toEqual([]);
  });

  it('reorders equal-shared collaborators by the temporal weight', () => {
    // Hub shares one file with each of Amy (stale) and Zoe (recent handoff).
    const graph = computeTeamGraph([
      { authorName: 'Hub', authorEmail: 'hub@x', authoredAt: day(0), files: ['a.ts'] },
      { authorName: 'Hub', authorEmail: 'hub@x', authoredAt: day(0), files: ['b.ts'] },
      { authorName: 'Amy', authorEmail: 'amy@x', authoredAt: day(400), files: ['a.ts'] },
      { authorName: 'Zoe', authorEmail: 'zoe@x', authoredAt: day(1), files: ['b.ts'] },
    ]);
    // All-time, the tie is a draw (1 shared file each) so name order wins → Amy.
    expect(collaboratorsOf(graph, 'hub@x', Infinity, 0).map((c) => c.name)).toEqual(['Amy', 'Zoe']);
    // Weighted toward recency, Zoe's day-apart handoff outranks Amy's stale tie.
    expect(collaboratorsOf(graph, 'hub@x', Infinity, 1).map((c) => c.name)).toEqual(['Zoe', 'Amy']);
  });
});
