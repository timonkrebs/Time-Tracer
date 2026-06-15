import { AuthoredCommit, collaboratorsOf, computeTeamGraph } from './team-graph';

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
    // files is also {auth, session} → strength 1. Cy shares nothing.
    expect(graph.collaborations).toEqual([{ a: 'Ada', b: 'Bo', sharedFiles: 2, strength: 1 }]);
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
    expect(graph.collaborations).toEqual([{ a: 'Bo', b: 'Cy', sharedFiles: 2, strength: 1 }]);
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
});

describe('collaboratorsOf', () => {
  it('lists a developer’s collaborators, most shared files first', () => {
    const graph = computeTeamGraph([
      { authorName: 'Ada', files: ['a', 'b', 'c'] },
      { authorName: 'Bo', files: ['a', 'b'] }, // shares 2 with Ada
      { authorName: 'Cy', files: ['c'] }, // shares 1 with Ada
    ]);
    expect(collaboratorsOf(graph, 'Ada')).toEqual([
      { name: 'Bo', sharedFiles: 2, strength: 2 / 3 },
      { name: 'Cy', sharedFiles: 1, strength: 1 / 3 },
    ]);
  });

  it('honours the limit and returns nothing for an isolated or unknown developer', () => {
    const graph = computeTeamGraph(COMMITS);
    expect(collaboratorsOf(graph, 'Ada', 0)).toEqual([]);
    expect(collaboratorsOf(graph, 'Cy')).toEqual([]); // a silo
    expect(collaboratorsOf(graph, 'nobody')).toEqual([]);
  });
});
