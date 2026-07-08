/**
 * Layout for the Branch Explorer — a horizontal commit graph in the spirit of
 * gmaster's branch explorer: every branch is a horizontal lane, commits flow
 * left → right in topological order (oldest left, newest right), merges curve
 * between lanes, and long linear runs collapse into a single "N commits" pill
 * so the interesting topology stays on one screen.
 *
 * Lanes follow git's own notion of a branch: the first-parent chain. The chain
 * walked from each loaded branch tip keeps that branch's lane; every merge
 * commit then opens an unnamed lane for the side branch it merged (its second
 * parent's first-parent chain), so merged feature branches read as their own
 * tracks even though git no longer remembers their names.
 *
 * Pure and deterministic — the store feeds it the commits it has loaded and
 * the component renders the returned coordinates; nothing here touches the
 * network or the DOM.
 */

/** The slice of a commit the layout needs; `CommitInfo` is assignable. */
export interface GraphCommit {
  readonly sha: string;
  readonly parentShas: readonly string[];
  /** ISO author date — used to order commits and break topological ties. */
  readonly authoredAt: string;
}

/** One horizontal track of the graph. */
export interface BranchGraphLane {
  readonly index: number;
  /** Branch name for lanes anchored at a loaded tip; null for merged side branches. */
  readonly label: string | null;
  /** The lane's newest commit — where its walk started. */
  readonly headSha: string;
  /** Loaded commits on this lane. */
  readonly size: number;
}

/** A visible commit dot. */
export interface CommitNode {
  readonly kind: 'commit';
  readonly sha: string;
  readonly lane: number;
  readonly column: number;
  /** Branch names pointing exactly at this commit. */
  readonly labels: readonly string[];
  readonly isMerge: boolean;
  /**
   * True when a parent lies beyond the loaded window (history continues past
   * the left edge). Root commits are not clipped — they are the true start.
   */
  readonly clipped: boolean;
}

/** A collapsed run of linear commits, drawn as one "N commits" pill. */
export interface CollapsedNode {
  readonly kind: 'collapsed';
  /** Stable id — the run's newest sha, so paging in older commits keeps it. */
  readonly id: string;
  readonly lane: number;
  readonly column: number;
  readonly count: number;
  /** The folded commits, newest first. */
  readonly shas: readonly string[];
}

export type BranchGraphNode = CommitNode | CollapsedNode;

/** An edge between two visible nodes; `from` is the older (left) side. */
export interface BranchGraphEdge {
  readonly fromColumn: number;
  readonly fromLane: number;
  readonly toColumn: number;
  readonly toLane: number;
  /**
   * `line` continues a lane; `merge` brings a side lane into the child's lane
   * (the child is a merge commit); `branch` forks the child's lane off its
   * first parent's lane (the child is the start of a branch).
   */
  readonly kind: 'line' | 'merge' | 'branch';
  /** Lane whose colour the edge takes — the side branch for merges/forks. */
  readonly colorLane: number;
}

export interface BranchGraph {
  readonly lanes: readonly BranchGraphLane[];
  readonly nodes: readonly BranchGraphNode[];
  readonly edges: readonly BranchGraphEdge[];
  readonly columnCount: number;
  /** Total commits laid out (visible + collapsed). */
  readonly commitCount: number;
}

/** Linear runs of at least this many plain commits fold into a pill. */
export const MIN_COLLAPSE_RUN = 4;

export interface BranchGraphOptions {
  /** Ids of collapsed runs the user expanded (see {@link CollapsedNode.id}). */
  readonly expanded?: ReadonlySet<string>;
  /** Runs of at least this many plain commits collapse; default {@link MIN_COLLAPSE_RUN}. */
  readonly collapseRunLength?: number;
}

/**
 * Lays out `commits` (any order, duplicates tolerated) into lanes and columns.
 * `heads` maps branch names to their tip shas in display-priority order — the
 * viewed ref first, so it claims the topmost lane; tips whose sha is missing
 * from `commits` are ignored.
 */
export function layoutBranchGraph(
  commits: readonly GraphCommit[],
  heads: ReadonlyMap<string, string>,
  options?: BranchGraphOptions,
): BranchGraph {
  const bySha = new Map<string, GraphCommit>();
  for (const commit of commits) if (!bySha.has(commit.sha)) bySha.set(commit.sha, commit);

  const order = topoOrder(bySha); // newest first, children before parents
  const topoIndex = new Map<string, number>();
  order.forEach((sha, i) => topoIndex.set(sha, i));

  // Branch names on their exact tip commits (several names may share one sha).
  const labels = new Map<string, string[]>();
  for (const [name, sha] of heads) {
    if (!bySha.has(sha)) continue;
    const list = labels.get(sha);
    if (list) list.push(name);
    else labels.set(sha, [name]);
  }

  // ---- Lane assignment ------------------------------------------------------
  const laneOf = new Map<string, number>();
  const lanes: { label: string | null; headSha: string; size: number }[] = [];

  /** Claims the first-parent chain from `start` for lane `lane`. */
  const walk = (start: string, lane: number): void => {
    let sha: string | undefined = start;
    while (sha !== undefined) {
      const commit = bySha.get(sha);
      if (!commit || laneOf.has(sha)) return;
      laneOf.set(sha, lane);
      lanes[lane].size++;
      sha = commit.parentShas[0];
    }
  };

  const openLane = (label: string | null, headSha: string): void => {
    lanes.push({ label, headSha, size: 0 });
    walk(headSha, lanes.length - 1);
  };

  // Named lanes first, in the callers' priority order (viewed ref first). A tip
  // that is already on another branch's chain gets no lane of its own — its
  // name still shows as a label on that commit.
  for (const [name, sha] of heads) {
    if (bySha.has(sha) && !laneOf.has(sha)) openLane(name, sha);
  }
  // Every merge opens an unnamed lane for the side branch it merged. Newest
  // first, so lanes read roughly in the order the work landed.
  for (const sha of order) {
    for (const parent of bySha.get(sha)!.parentShas.slice(1)) {
      if (bySha.has(parent) && !laneOf.has(parent)) openLane(null, parent);
    }
  }
  // Chains cut loose by the loading window (no loaded child reaches them).
  for (const sha of order) {
    if (!laneOf.has(sha)) openLane(null, sha);
  }

  // ---- Collapse linear runs -------------------------------------------------
  const childrenOf = new Map<string, string[]>();
  for (const commit of bySha.values()) {
    for (const parent of commit.parentShas) {
      if (!bySha.has(parent)) continue;
      const list = childrenOf.get(parent);
      if (list) list.push(commit.sha);
      else childrenOf.set(parent, [commit.sha]);
    }
  }

  /**
   * A commit is plain when hiding it cannot hide topology: exactly one loaded
   * parent and one loaded child, both on its own lane (so the only edges
   * through it are straight lane continuations), and no branch name on it.
   */
  const isPlain = (sha: string): boolean => {
    const commit = bySha.get(sha)!;
    if (commit.parentShas.length !== 1) return false;
    const parent = commit.parentShas[0];
    if (!bySha.has(parent)) return false;
    const children = childrenOf.get(sha) ?? [];
    if (children.length !== 1) return false;
    const lane = laneOf.get(sha);
    if (laneOf.get(parent) !== lane || laneOf.get(children[0]) !== lane) return false;
    if (bySha.get(children[0])!.parentShas[0] !== sha) return false;
    return !labels.has(sha);
  };

  const expanded = options?.expanded ?? new Set<string>();
  const minRun = options?.collapseRunLength ?? MIN_COLLAPSE_RUN;
  const pills: { id: string; lane: number; shas: string[] }[] = [];

  for (let lane = 0; lane < lanes.length; lane++) {
    // The lane's chain, newest → oldest.
    const chain: string[] = [];
    let sha: string | undefined = lanes[lane].headSha;
    while (sha !== undefined && laneOf.get(sha) === lane) {
      chain.push(sha);
      sha = bySha.get(sha)!.parentShas[0];
    }
    let runStart = -1;
    const closeRun = (end: number): void => {
      const length = end - runStart;
      if (runStart >= 0 && length >= minRun && !expanded.has(chain[runStart])) {
        pills.push({ id: chain[runStart], lane, shas: chain.slice(runStart, end) });
      }
      runStart = -1;
    };
    for (let i = 0; i < chain.length; i++) {
      if (isPlain(chain[i])) {
        if (runStart === -1) runStart = i;
      } else {
        closeRun(i);
      }
    }
    closeRun(chain.length);
  }

  // ---- Columns ---------------------------------------------------------------
  // One column per visible node, oldest at column 0. A pill sits at its newest
  // member's topological position; hidden members yield their columns, which
  // is exactly the space saving.
  const pillIdOf = new Map<string, string>(); // hidden member sha → pill id
  for (const pill of pills) for (const memberSha of pill.shas) pillIdOf.set(memberSha, pill.id);

  type Slot = { sha: string; pill?: { id: string; lane: number; shas: string[] } };
  const pillByNewest = new Map(pills.map((pill) => [pill.shas[0], pill]));
  const slots: Slot[] = [];
  for (const sha of order) {
    if (!pillIdOf.has(sha)) {
      slots.push({ sha });
      continue;
    }
    const pill = pillByNewest.get(sha);
    if (pill) slots.push({ sha, pill }); // the pill occupies its newest member's slot
  }
  slots.reverse(); // oldest first → column index

  const columnOf = new Map<string, number>(); // visible sha or pill id → column
  const nodes: BranchGraphNode[] = [];
  slots.forEach((slot, column) => {
    if (slot.pill) {
      columnOf.set(slot.pill.id, column);
      for (const memberSha of slot.pill.shas) columnOf.set(memberSha, column);
      nodes.push({
        kind: 'collapsed',
        id: slot.pill.id,
        lane: slot.pill.lane,
        column,
        count: slot.pill.shas.length,
        shas: slot.pill.shas,
      });
      return;
    }
    const commit = bySha.get(slot.sha)!;
    columnOf.set(slot.sha, column);
    nodes.push({
      kind: 'commit',
      sha: slot.sha,
      lane: laneOf.get(slot.sha)!,
      column,
      labels: labels.get(slot.sha) ?? [],
      isMerge: commit.parentShas.length > 1,
      clipped: commit.parentShas.some((parent) => !bySha.has(parent)),
    });
  });

  // ---- Edges -----------------------------------------------------------------
  // For every visible child → parent link; a hidden endpoint resolves to its
  // pill. Pill-internal links (both ends in the same pill) drop out.
  const edges: BranchGraphEdge[] = [];
  const seen = new Set<string>();
  const push = (
    fromSha: string,
    fromLane: number,
    toSha: string,
    toLane: number,
    kind: BranchGraphEdge['kind'],
    colorLane: number,
  ): void => {
    const key = `${fromSha}→${toSha}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      fromColumn: columnOf.get(fromSha)!,
      fromLane,
      toColumn: columnOf.get(toSha)!,
      toLane,
      kind,
      colorLane,
    });
  };

  for (const sha of order) {
    const commit = bySha.get(sha)!;
    const childLane = laneOf.get(sha)!;
    const childKey = pillIdOf.get(sha) ?? sha;
    commit.parentShas.forEach((parent, index) => {
      if (!bySha.has(parent)) return;
      const parentLane = laneOf.get(parent)!;
      const parentKey = pillIdOf.get(parent) ?? parent;
      if (parentKey === childKey) return; // inside one pill
      const kind: BranchGraphEdge['kind'] =
        parentLane === childLane ? 'line' : index === 0 ? 'branch' : 'merge';
      const colorLane = kind === 'merge' ? parentLane : childLane;
      push(parentKey, parentLane, childKey, childLane, kind, colorLane);
    });
  }

  edges.sort(
    (a, b) => a.fromColumn - b.fromColumn || a.toColumn - b.toColumn || a.toLane - b.toLane,
  );

  return {
    lanes: lanes.map((lane, index) => ({ index, ...lane })),
    nodes,
    edges,
    columnCount: slots.length,
    commitCount: bySha.size,
  };
}

/**
 * Topological order, newest first — every commit before its parents. Among the
 * commits whose loaded children are all emitted, the newest author date goes
 * first (sha as the deterministic tie-break), so columns still read as a
 * timeline wherever the DAG allows it.
 */
function topoOrder(bySha: ReadonlyMap<string, GraphCommit>): string[] {
  const pendingChildren = new Map<string, number>();
  for (const commit of bySha.values()) {
    for (const parent of commit.parentShas) {
      if (bySha.has(parent)) pendingChildren.set(parent, (pendingChildren.get(parent) ?? 0) + 1);
    }
  }

  const time = (sha: string): number => {
    const t = Date.parse(bySha.get(sha)!.authoredAt);
    return Number.isFinite(t) ? t : 0;
  };
  // Ascending by (time, sha); pop() takes the newest.
  const ready: string[] = [];
  const insert = (sha: string): void => {
    const t = time(sha);
    let lo = 0;
    let hi = ready.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const other = ready[mid];
      const to = time(other);
      if (to < t || (to === t && other < sha)) lo = mid + 1;
      else hi = mid;
    }
    ready.splice(lo, 0, sha);
  };

  for (const sha of bySha.keys()) {
    if (!pendingChildren.has(sha)) insert(sha);
  }

  const order: string[] = [];
  while (ready.length > 0) {
    const sha = ready.pop()!;
    order.push(sha);
    for (const parent of bySha.get(sha)!.parentShas) {
      if (!bySha.has(parent)) continue;
      const remaining = pendingChildren.get(parent)! - 1;
      if (remaining === 0) {
        pendingChildren.delete(parent);
        insert(parent);
      } else {
        pendingChildren.set(parent, remaining);
      }
    }
  }
  // A cycle cannot happen in a real git DAG; if corrupt input produced one,
  // append the leftovers newest-first so the layout still terminates.
  if (order.length < bySha.size) {
    const rest = [...bySha.keys()].filter((sha) => !order.includes(sha));
    rest.sort((a, b) => time(b) - time(a) || (a < b ? -1 : 1));
    order.push(...rest);
  }
  return order;
}
