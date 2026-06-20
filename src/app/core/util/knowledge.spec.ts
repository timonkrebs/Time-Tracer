import {
  KnowledgeCommit,
  RISK_THRESHOLDS,
  computeKnowledgeRisk,
  isBotAuthor,
  riskLevel,
} from './knowledge';

const DAY_MS = 86_400_000;
/** A fixed "now" so age- and inactivity-based weighting is deterministic. */
const NOW = Date.parse('2026-06-14T00:00:00Z');
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY_MS).toISOString();

function kc(authoredAt: string, files: string[], authorName = 'Ada'): KnowledgeCommit {
  return { authorName, authoredAt, files };
}

const opts = { now: NOW };

describe('computeKnowledgeRisk', () => {
  it('tallies total lines deleted per author for the code-eliminator stat', () => {
    const model = computeKnowledgeRisk(
      [
        { authorName: 'Ada', authoredAt: iso(2), files: ['a.ts'], deletions: 30 },
        { authorName: 'Ada', authoredAt: iso(5), files: ['b.ts'], deletions: 12 },
        // A sweep over more files than the expertise gate allows still counts its
        // deleted lines toward the author's eliminator tally.
        {
          authorName: 'Ada',
          authoredAt: iso(9),
          files: Array.from({ length: 40 }, (_, i) => `f${i}.ts`),
          deletions: 500,
        },
        { authorName: 'Linus', authoredAt: iso(3), files: ['c.ts'], deletions: 5 },
        // A commit whose provider didn't report deletions contributes nothing.
        { authorName: 'Linus', authoredAt: iso(4), files: ['d.ts'] },
        // Bots are excluded from the tally entirely.
        { authorName: 'dependabot[bot]', authoredAt: iso(1), files: ['e.ts'], deletions: 999 },
      ],
      new Map([
        ['a.ts', 100],
        ['b.ts', 100],
        ['c.ts', 100],
        ['d.ts', 100],
      ]),
      opts,
    );

    const byName = new Map(model.authors.map((a) => [a.name, a]));
    expect(byName.get('Ada')!.deletions).toBe(542);
    expect(byName.get('Linus')!.deletions).toBe(5);
    expect(byName.has('dependabot[bot]')).toBe(false);
  });

  it('flags a file whose sole author has gone quiet, and spares a co-owned active one', () => {
    const model = computeKnowledgeRisk(
      [
        // 'Gone' last committed ~6 months ago and never since → departed.
        kc(iso(190), ['src/legacy.ts'], 'Gone'),
        kc(iso(210), ['src/legacy.ts'], 'Gone'),
        // Two contributors still active this week share the other file.
        kc(iso(3), ['src/live.ts'], 'Ada'),
        kc(iso(5), ['src/live.ts'], 'Linus'),
      ],
      new Map([
        ['src/legacy.ts', 800],
        ['src/live.ts', 400],
      ]),
      opts,
    );

    const legacy = model.files.find((f) => f.path === 'src/legacy.ts')!;
    const live = model.files.find((f) => f.path === 'src/live.ts')!;

    // The orphaned file ranks first and carries most of its risk.
    expect(model.files[0].path).toBe('src/legacy.ts');
    expect(legacy.orphanedShare).toBeGreaterThan(0.5);
    expect(legacy.primaryExpert!.name).toBe('Gone');
    expect(legacy.primaryExpert!.active).toBe(false);

    // The actively co-owned file is barely at risk.
    expect(live.orphanedShare).toBeLessThan(0.05);
    expect(live.experts.every((e) => e.active)).toBe(true);
    expect(legacy.riskScore).toBeGreaterThan(live.riskScore);
  });

  it('ranks orphaned files by size, not by how recently they were last touched', () => {
    const model = computeKnowledgeRisk(
      [
        // A big file abandoned very long ago by a departed author (tiny recency
        // weight) — the textbook knowledge-loss case.
        kc(iso(900), ['src/big-legacy.ts'], 'Alex'),
        // A smaller file abandoned more recently (still long ago) by another.
        kc(iso(200), ['src/small-old.ts'], 'Blake'),
      ],
      new Map([
        ['src/big-legacy.ts', 3000],
        ['src/small-old.ts', 300],
      ]),
      opts,
    );

    const big = model.files.find((f) => f.path === 'src/big-legacy.ts')!;
    const small = model.files.find((f) => f.path === 'src/small-old.ts')!;

    // Both are orphaned (their authors are long gone)…
    expect(big.orphanedShare).toBeGreaterThan(0.5);
    expect(small.orphanedShare).toBeGreaterThan(0.5);
    // …and the larger file is the bigger knowledge loss, even though it was last
    // touched far less recently — recency must not drive the ranking.
    expect(big.riskScore).toBeGreaterThan(small.riskScore);
    expect(model.files[0].path).toBe('src/big-legacy.ts');
  });

  it('still ranks by orphaned share when the provider reports no file sizes', () => {
    const model = computeKnowledgeRisk(
      [kc(iso(220), ['src/legacy.ts'], 'Gone'), kc(iso(2), ['src/live.ts'], 'Ada')],
      new Map(), // GitLab / Bitbucket Server give tree entries without sizes
      opts,
    );
    const legacy = model.files.find((f) => f.path === 'src/legacy.ts')!;
    // Falls back to a flat weight, so an orphaned file still scores (not all-zero).
    expect(legacy.riskScore).toBeGreaterThan(0);
    expect(model.files[0].path).toBe('src/legacy.ts');
  });

  it('weights a more recent author as the primary expert of a shared file', () => {
    const model = computeKnowledgeRisk(
      [
        kc(iso(2), ['src/shared.ts'], 'Recent'),
        kc(iso(300), ['src/shared.ts'], 'Older'),
        kc(iso(330), ['src/shared.ts'], 'Older'),
      ],
      new Map(),
      opts,
    );
    const shared = model.files[0];
    // Two old commits, but the single fresh one carries more weighted knowledge.
    expect(shared.primaryExpert!.name).toBe('Recent');
    expect(shared.experts.find((e) => e.name === 'Recent')!.share).toBeGreaterThan(0.5);
  });

  it('excludes bot authors by default and counts them when overridden', () => {
    const commits = [kc(iso(5), ['src/a.ts'], 'Ada'), kc(iso(1), ['src/a.ts'], 'dependabot[bot]')];

    const human = computeKnowledgeRisk(commits, new Map(), opts);
    expect(human.commitsUsed).toBe(1);
    expect(human.authors.map((a) => a.name)).toEqual(['Ada']);
    expect(human.files[0].experts).toHaveLength(1);

    const all = computeKnowledgeRisk(commits, new Map(), { ...opts, ignoreAuthor: () => false });
    expect(all.commitsUsed).toBe(2);
    expect(all.authors.map((a) => a.name).sort()).toEqual(['Ada', 'dependabot[bot]']);
  });

  it('drops sweeping commits that touch more files than the cap', () => {
    const model = computeKnowledgeRisk(
      [
        kc(iso(1), ['x.ts', 'y.ts', 'z.ts'], 'Ada'), // a sweep
        kc(iso(2), ['x.ts'], 'Ada'),
      ],
      new Map(),
      { ...opts, maxCommitFiles: 2 },
    );
    expect(model.commitsUsed).toBe(1);
    expect(model.files.map((f) => f.path)).toEqual(['x.ts']);
  });

  it('counts a recent sweep as presence, so its author is not mistaken for departed', () => {
    const model = computeKnowledgeRisk(
      [
        // Ada wrote auth.ts long ago…
        kc(iso(220), ['src/auth.ts'], 'Ada'),
        // …and her only *recent* commit is a repo-wide formatting sweep.
        kc(iso(2), ['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts'], 'Ada'),
      ],
      new Map(),
      { ...opts, maxCommitFiles: 2 },
    );

    const ada = model.authors.find((a) => a.name === 'Ada')!;
    // The sweep keeps her active even though it grants no per-file expertise.
    expect(ada.active).toBe(true);
    expect(ada.lastActiveAt).toBe(iso(2));

    // Only auth.ts has expertise (the sweep files got none)…
    expect(model.files.map((f) => f.path)).toEqual(['src/auth.ts']);
    // …and it is not treated as orphaned, because Ada is still around.
    expect(model.files[0].orphanedShare).toBeLessThan(0.05);
    expect(model.files[0].primaryExpert!.active).toBe(true);
  });

  it('counts a generated-only commit (left empty by filtering) as presence', () => {
    const model = computeKnowledgeRisk(
      [
        // Bea wrote the parser long ago…
        kc(iso(220), ['src/parser.ts'], 'Bea'),
        // …and her only recent commit touched generated/vendored files the store
        // filters out, so it reaches the model with no files left.
        kc(iso(2), [], 'Bea'),
      ],
      new Map(),
      opts,
    );

    const bea = model.authors.find((a) => a.name === 'Bea')!;
    // The empty commit keeps her present even though it grants no expertise.
    expect(bea.active).toBe(true);
    expect(bea.lastActiveAt).toBe(iso(2));
    expect(bea.commits).toBe(2);

    // parser.ts is still hers and not treated as orphaned…
    expect(model.files.map((f) => f.path)).toEqual(['src/parser.ts']);
    expect(model.files[0].orphanedShare).toBeLessThan(0.05);
    // …and only the parser commit grants per-file expertise.
    expect(model.commitsUsed).toBe(1);
  });

  it('omits files whose only authorship is undated, instead of showing 0% risk', () => {
    const model = computeKnowledgeRisk(
      [
        kc(iso(3), ['src/dated.ts'], 'Ada'),
        // Bea's commit has no parseable date (the provider left it blank).
        kc('', ['src/undated.ts'], 'Bea'),
      ],
      new Map([
        ['src/dated.ts', 100],
        ['src/undated.ts', 100],
      ]),
      opts,
    );

    // The undated file is left out — there's no temporal basis to call it owned…
    expect(model.files.map((f) => f.path)).toEqual(['src/dated.ts']);
    expect(model.commitsUsed).toBe(1);
    // …but its author still registers as present (the commit did happen).
    const bea = model.authors.find((a) => a.name === 'Bea')!;
    expect(bea.commits).toBe(1);
    expect(bea.lastActiveAt).toBeNull();
  });

  it('summarizes contributor presence sorted by knowledge with activity flags', () => {
    const model = computeKnowledgeRisk(
      [
        kc(iso(1), ['a.ts'], 'Active'),
        kc(iso(2), ['b.ts'], 'Active'),
        kc(iso(400), ['c.ts'], 'Gone'),
      ],
      new Map(),
      opts,
    );
    expect(model.authors[0].name).toBe('Active');
    const active = model.authors.find((a) => a.name === 'Active')!;
    const gone = model.authors.find((a) => a.name === 'Gone')!;
    expect(active.active).toBe(true);
    expect(active.departed).toBeLessThan(0.1);
    expect(gone.active).toBe(false);
    expect(gone.departed).toBeGreaterThan(0.5);
  });

  it('computes a bus factor from the knowledge concentration', () => {
    const model = computeKnowledgeRisk(
      [
        // One author dominates → bus factor 1.
        kc(iso(1), ['solo.ts'], 'Ada'),
        kc(iso(2), ['solo.ts'], 'Ada'),
        kc(iso(3), ['solo.ts'], 'Ada'),
        kc(iso(4), ['solo.ts'], 'Bob'),
      ],
      new Map(),
      opts,
    );
    expect(model.files[0].busFactor).toBe(1);
  });

  it('clamps future-dated commits (clock skew) rather than over-weighting them', () => {
    const model = computeKnowledgeRisk([kc(iso(-30), ['a.ts'], 'Ada')], new Map(), opts);
    // Weight is clamped to 1, and a just-"committed" author is fully active.
    expect(model.authors[0].knowledge).toBeCloseTo(1, 5);
    expect(model.authors[0].active).toBe(true);
    expect(model.files[0].orphanedShare).toBeLessThan(0.05);
  });

  it('passes the partial flag through to the model and its files', () => {
    const ready = computeKnowledgeRisk([kc(iso(1), ['a.ts'], 'Ada')], new Map(), opts);
    expect(ready.partial).toBe(false);
    expect(ready.files[0].partial).toBe(false);

    const capped = computeKnowledgeRisk([kc(iso(1), ['a.ts'], 'Ada')], new Map(), {
      ...opts,
      partial: true,
    });
    expect(capped.partial).toBe(true);
    expect(capped.files[0].partial).toBe(true);
  });

  it('handles an empty history', () => {
    const model = computeKnowledgeRisk([], new Map(), opts);
    expect(model).toMatchObject({ commitsUsed: 0, authors: [], files: [], partial: false });
  });
});

describe('isBotAuthor', () => {
  it('matches automated accounts but not lookalike human names', () => {
    expect(isBotAuthor('dependabot[bot]')).toBe(true);
    expect(isBotAuthor('github-actions[bot]')).toBe(true);
    expect(isBotAuthor('renovate')).toBe(true);
    expect(isBotAuthor('Abbot')).toBe(false);
    expect(isBotAuthor('robot')).toBe(false);
    expect(isBotAuthor('Ada Lovelace')).toBe(false);
  });
});

describe('riskLevel', () => {
  it('maps orphaned share onto well-known→orphaned buckets', () => {
    expect(riskLevel(0)).toBe(0);
    expect(riskLevel(0.1)).toBe(0);
    expect(riskLevel(0.25)).toBe(1);
    expect(riskLevel(0.5)).toBe(2);
    expect(riskLevel(0.8)).toBe(3);
    expect(riskLevel(1)).toBe(4);
  });

  it('changes band exactly at each RISK_THRESHOLDS boundary', () => {
    RISK_THRESHOLDS.forEach((threshold, level) => {
      expect(riskLevel(threshold)).toBe(level);
      if (level > 0) expect(riskLevel(threshold - 0.001)).toBe(level - 1);
    });
  });
});
