# Architecture & Performance Review — July 2026

A full-codebase review of Time Tracer: the signals store and analysis pipeline, the
viewer/insights UI, the pure algorithm layer, and the five-provider git abstraction.
Findings are ranked and carry `file:line` anchors (line numbers as of this review's
base commit). A batch of the highest-leverage fixes landed alongside this document —
see [What was fixed in this change](#what-was-fixed-in-this-change) — everything else
is a prioritized backlog.

## Executive summary

The foundations are unusually strong for a project of this shape: the diff engine is a
real linear-space Myers implementation (not a naive DP), the analysis layer is pure,
deterministic and worker-ready, the provider registry makes a sixth host a one-line
registration, and staleness guards, in-flight dedup and streaming publishes exist
almost everywhere they should. The specs (829 tests) pin the load-bearing behavior,
including diff minimality via randomized round-trips.

The problems concentrate in four systemic patterns rather than in any single bad file:

1. **Two god objects.** `RepoStore` (~2,950 lines, ~14 responsibilities) and
   `InsightsView` (~3,700 lines, 7 tabs in one component + one 1,840-line inline
   template). Every new feature has been bolted onto them as another signal cluster +
   run counter + walk method. The seams for decomposition are already visible.
2. **Recompute-from-scratch streaming.** Every streamed progress update recomputes
   derived state over the *whole* window so far: `aggregateInsights` re-runs
   co-change/hotspots/team/knowledge/forecast over all collected commits per pump;
   `summarizeSurvival` re-copies and re-sorts every line lifetime on the main thread
   every 600 ms; the UI layer re-clusters, re-lays-out and re-formats per publish.
   Total work is O(n²) over a walk that should be O(n).
3. **Copy-on-write Map signals.** `setFileState`/`setBlameState`/`cacheCommits` all
   clone the full Map per write (`new Map(this._x())`), making every long walk
   quadratic in map entries and every publish a full-map copy.
4. **No request cancellation and unbounded caches.** Zero `AbortController` usage;
   navigating away drops results but lets up to 12 in-flight prefetches complete
   against the rate budget. `_files`, `treeCache`, `commitFilesCache` and
   `survivalLifetimes` grow without eviction until the next `loadRepo`.

None of these is architectural rot — they are the natural scars of feature velocity,
and all four have mechanical, testable fixes.

## What is genuinely good (keep it this way)

- `core/util` is pure, deterministic, `now`-injectable and thoroughly spec'd. Wilson
  lower bounds for coupling confidence, binary-search temporal closeness, union-find
  components, Kaplan–Meier with censoring — the algorithm quality is high.
- `diff.ts` implements Myers' middle-snake linear-space variant with prefix/suffix
  trimming and a degenerate-input size guard. Minimality is spec-pinned with 200
  randomized cases.
- The `GitProvider` injection-token registry: adding a host is one `app.config.ts`
  line. The local provider's hand-rolled log/tree memoization (WeakMap-per-fs so
  caches die with the filesystem handle) shows real care.
- The store's load-sequence guard idiom, the `ensureFile` in-flight promise dedup, the
  bounded-prefetch pipelining of the co-change and survival walks, and the
  `pump`/supersede coalescing of worker aggregations are all correct designs.
- The UI layer cleans up after itself: no leaked global listeners found anywhere;
  `ResizeObserver` disposal, `afterRenderEffect` scroll restoration and the split-pane
  scroll feedback guard are all done right. `file-view`'s row virtualization is a
  model implementation.

---

## Layer 1 — Store & analysis pipeline

### High

- **`RepoStore` is a god object** (`repo-store.ts:342`). It carries load lifecycle,
  tree state, UI selection, the file-content cache, the commit index, history paging
  (four near-duplicate implementations), the blame engine, the line-trace engine,
  hunk-origin search, rename search, folder ownership scanning, two co-change walks,
  the survival walk (~420 lines with inline rename detection), and links/recents.
  **Fix:** keep a slim `RepoSession` (slug/ref/phase/tree/selection, load epoch) and
  extract `FileContentCache`, `CommitIndex`, `FileHistoryStore`, `BlameEngine`,
  `LineTraceEngine`, `RenameSearch`, `OwnershipScanner`, `InsightsWalker`. Each
  feature already has its own signal cluster + run counter + clear method — the
  extraction is mostly mechanical.
- **`historyFor` wrote caches without a staleness guard** (`repo-store.ts:1233`).
  Every other async flow checks `seq !== this.loadSeq` before writing;
  `historyFor` didn't — a stale response from an abandoned navigation could file the
  *old repo's* history under a bare path key (`README.md`, `package.json`) that the
  new repo then serves as its own, with wrong blame and hotspot badges downstream.
  **Fixed in this change** (guard added; `lastTouch` hardened too).
- **Copy-on-write Map signals make walks quadratic** (`repo-store.ts:2829–2902`).
  `setFileState`, `setBlameState`, `setDiffState`, `recordMetric` and `cacheCommits`
  all do `new Map(this._x())` per write. A blame over N history steps does two
  `_files` clones per step (O(N²) map-entry copies); `cacheCommits` clones
  `_commitsBySha` once per 30-commit page — for a 100k-commit "Load all" that is
  ~1.7e8 map inserts. **Fix:** private mutable Maps + a bumped `version` signal that
  computeds read, or batched writes per page/step. `_commitsBySha` has almost no
  reactive consumers and is the drop-in candidate to convert first.
- **Survival roll-up runs O(all lifetimes · log) on the main thread every 600 ms**
  (`repo-store.ts:1787–1812`, `survival.ts:129,396`). Each publish copies the full
  lifetime table (~1M entries on a mature repo, 3–4 materializations) and re-sorts it
  for Kaplan–Meier — several hundred ms of jank, repeated for the whole minutes-long
  walk, while the analysis worker sits idle. **Fix:** move `summarizeSurvival` into
  the worker (its output is already structured-clone-safe by design) and/or keep the
  observation list sorted incrementally; longer-term store lifetimes as
  struct-of-arrays (typed arrays) instead of one boxed object per line ever born.
- **Fully-cached walks never yielded to the renderer** (`repo-store.ts:996–1085`,
  `2287–2368`). When every version is already cached (local repos, re-walks after
  paging) each `await ensureFile(...)` resolves as a microtask, so the whole
  blame/trace walk ran as one unbroken block and none of its streamed progress ever
  painted. **Fixed in this change** (macrotask yield every 16 steps in both walks).

### Medium

- **Seven parallel hand-rolled cancellation mechanisms** (`loadSeq` + six run
  counters + `blameRuns` + ad-hoc path checks, `repo-store.ts:347–448`). The idiom
  varies per method and the capture point differs, which is exactly how the
  `historyFor` hole happened. **Fix:** one `LoadEpoch` token minted by `loadRepo`
  (ideally backed by `AbortController` so provider fetches actually cancel), child
  tokens per feature. This is also the prerequisite for decomposing the store.
- **Unbounded caches** (`repo-store.ts:381,396,435,445`): `_files` keeps full text
  for every `<sha, path>` ever touched (a 400-step blame stores 400 file copies);
  `treeCache` holds full recursive trees per sha and survives same-repo ref reloads;
  `commitFilesCache` retains GitHub `patch` hunks for the whole history after
  "Load all"; `survivalLifetimes` holds one object per line ever observed,
  indefinitely after the walk. **Fix:** LRU with a byte budget for `_files` and
  `treeCache`; strip `patch` after the survival walk consumes it; drop
  `survivalLifetimes` when the Age tab is left.
- **History loading exists four times with a duplicate-request race**
  (`loadHistory`/`loadMoreHistory`/`loadAllHistory`/`historyFor`). Nothing dedupes
  in-flight history loads the way `ensureFile` dedupes files: blame of an unselected
  path racing a selection fires the same page-1 request twice, last write wins.
  **Fix:** one `HistoryLoader.ensure(path, throughPage)` with an in-flight map;
  the public methods become thin wrappers over the panel signals.
- **Blame restarts from scratch on every history extension**
  (`repo-store.ts:925–938`). `processed` exists to support resumption, but `runBlame`
  always re-walks from the anchor, re-diffing every already-processed step —
  O(pages²) diff work across repeated "Load more", plus a visible flicker as `owners`
  resets. **Fix:** persist the walk cursor (`images`, `pending`, position) with the
  truncated state and resume at `history[processed]`.
- **Blame publishes per step with no time budget** (`repo-store.ts:990–1092`): each
  step clones the blame map and invalidates `selectedOwnership` +
  `selectedFileRisk` — two O(lines) folds — per commit walked. The survival walk
  already has `SURVIVAL_PUBLISH_MS = 600`; blame deserves the same throttle.
- **`folderOwnershipFromCache` re-folds the whole folder on every blame write
  anywhere** (`repo-store.ts:1359–1387`, `viewer-page.ts:723`): the computed reads
  the whole `_blames` map signal, so unrelated blame progress invalidates it; each
  recompute re-sorts all tree entries and re-concatenates every line of up to 30
  files. **Fix:** depend on the ≤30 relevant per-file states only, memoize when their
  references are unchanged.
- **Worker protocol gaps** (`analysis-runner.ts:15–51`): no cancel message (a
  superseded walk's aggregation still burns the serial worker), `pending` entries
  leak if the worker never replies, `onerror` dumps every queued heavy aggregation
  synchronously onto the main thread, and the repo-wide `sizes` map is re-cloned on
  every run. **Fix:** cancel-by-id, a session message carrying `sizes` once, lazy
  fallback on error.

### Low

- `hasLocalData` sniffs `primeHistories != null` as a proxy for "local provider" —
  make it an explicit `capabilities` field on `GitProvider`
  (`repo-store.ts:503–506`). The `'github-rename'` reason string is emitted for all
  providers (`models.ts:127`).
- Two host-equality rules: `isCurrentTarget` normalizes trailing slashes via
  `sameHost`, `isSameRepo` compares raw strings (`repo-store.ts:2874` vs `2919`).
- `fileKey(path, at)` uses the `'tip'` sentinel; `?at=tip` (user-controlled) collides
  with the tip cache key (`repo-store.ts:2935`). Reject non-hex `at` at the route
  boundary or prefix real shas.
- Azure DevOps chain building resolves parents one commit per round trip
  (`repo-store.ts:1846`) — batch with the existing prefetch window.
- Doc rot in `models.ts` (`CommitInfo` "not yet surfaced", `FileState` key format).

## Layer 2 — Viewer & Insights UI

### High

- **`InsightsView` hosts seven tabs in one component** (`insights-view.ts`,
  ~1,840-line inline template, ~90 members, four chart-geometry builders, a poster
  renderer and an export subsystem). Beyond maintainability this is the performance
  face of Angular's per-component reactivity: any `hovered.set(...)` or slider tick
  re-runs the whole active tab's bindings. **Fix:** per-tab child components with an
  `InsightsView` shell (~200 lines); each tab takes only its slice of state. The
  hover tooltip belongs in its own ~50-line child.
- **The diff view renders every row with zero virtualization; split mode doubles it**
  (`diff-view.ts:294,372,467`). A 10k-line diff is 2×10k flex rows with blame
  gutters. `file-view.ts` already solved this exact problem
  (`VIRTUALIZE_THRESHOLD = 800`, fixed 24-px rows, spacer windowing) — the diff view
  never adopted it. **Fix:** reuse the same windowing; in split mode drive both panes
  from one shared `scrollTop`.
- **The focus effect hijacked the active tab on every streamed publish**
  (`insights-view.ts:3038`): `effect(() => { if (this.focus()) this.tab.set('coupling') })`
  reacted to state *identity*, which is replaced every few commits during a focus
  walk — the user was snapped back to Coupling for the walk's whole duration.
  **Fixed in this change** (keyed on the focused file, not the state object).
- **The Timing slider re-ran a 300-iteration O(n²) force simulation per input event**
  (`insights-view.ts:2563`, `force-layout.ts`). At 40–100 nodes with `Map` lookups
  and `Math.hypot` per pair this measured 18–120 ms per tick — sustained jank while
  dragging. **Fixed in this change** at the simulation layer: `forceLayout` now runs
  on flat typed arrays (measured 15–18× faster: 18 ms → 1.2 ms at n=40,
  121 ms → 6.4 ms at n=100). A further refinement (re-derive only edge strengths on
  weight change, keep node positions) remains available if bigger graphs arrive.
- **The cluster-size slider re-clustered the full pair list per input event**
  (`insights-view.ts:2396`): union-find over potentially 10⁵+ pairs per drag tick.
  **Fixed in this change:** components are computed once per analysis state; the
  size band is a cheap filter on top.

### Medium

- **Streaming publishes invalidate the whole computed chain every 5 commits**
  (`repo-store.ts:1740` + `insights-view.ts:2498`): `labels` reads `clusters`, which
  read the uncapped pair list, so `clusterCoChange` + `disambiguateLabels` +
  `squarify` + `quadrant` + `busFactorBoard` re-ran per pump for the entire "Load
  all" duration. Partially addressed in this change (cluster split, one-pass
  `busFactorBoard`); the remaining fix is time-throttling the store's pump (≥250 ms)
  and feeding display computeds from capped slices.
- **File history panel**: unvirtualized commit list after "Load all" (thousands of
  rows), `relativeTime` re-formatted per row per change detection, and the trace
  Markdown export rebuilt per CD while the banner is visible
  (`file-history.ts:133,342,359`). **Fix:** window the list, pre-format dates in a
  view-model computed, make the export lazy/computed.
- **Template duplication**: the "Analyze history" CTA ×6, the tab strip ×7, the
  dual-range slider ×2, pair-row markup ×2 (`insights-view.ts` template), and the
  blame-gutter cell ×3 across `file-view.ts:218` / `diff-view.ts:324,384` (three
  copies that must stay pixel-identical for split alignment). Extract
  `<app-analyze-cta>`, `<app-size-slider>`, `<app-pair-row>`, `<app-blame-cell>`.
- **Tree-resize drag** sets width per `pointermove` without rAF coalescing, and
  `store.linksFor()` allocates a fresh object per viewer CD
  (`viewer-page.ts:161,1536`).
- **File finder** rescans and re-lowercases all paths per keystroke
  (`file-finder.ts:158`, `fuzzy.ts:43`) — noticeable at 80k files. Cache lowered
  strings with the file list; filter the previous result set when the query extends.

### Low

- Insights UI state (active tab, sliders, selections) is destroyed when toggling to a
  file and back (`viewer-page.ts:373`) — lift it into query params or the store.
- Two independent heat-color systems that promise to agree but can drift
  (`heat.ts` vs `insights-view.ts:91`); `formatBytes` exists twice with different
  output (`insights-view.ts:157` vs `file-view.ts:34`); basename extraction ×4;
  micro-helpers (`pct`/`when`/`abbrev`) re-declared across five components.
- Dead aliases (`list`, `riskList`), unused chart-geometry fields, and literal
  `**markdown**` shown to users in an empty state (`insights-view.ts:2241`).

## Layer 3 — Algorithms (`core/util`)

### High

- **Survival rename scoring ran up to 200 worst-case Myers diffs of dissimilar whole
  files per commit** (`repo-store.ts:2085–2103`). For unrelated files the minimal
  diff costs ~(n+m)²/4 — two 4k-line files ≈ hundreds of ms each, so one
  delete-14/add-14 refactor commit could stall the tab for tens of seconds.
  **Fixed in this change** with the provably output-identical size-ratio prefilter
  (`lineSimilarity ≤ min/max line count`, so pairs below the 0.5 threshold's reach
  are skipped without diffing) plus hoisting the per-source join out of the inner
  loop. A hashed-line-multiset upper bound would tighten it further if needed.
- **`movedLinePairs` is O(addRuns × removeRuns × runLength)**
  (`line-range.ts:208–226`) and receives its own worst case from the diff
  `SIZE_GUARD` degrade path (one giant remove run vs one giant add run). Runs per
  step of blame, trace *and* survival. **Fix:** index removed lines by first-line
  text (`Map<text, positions[]>`) and only probe offsets where the add run's first
  line occurs; add a total-probe budget as a backstop.
- **`findBlockOrigin` allocates a block×file direction matrix with no cap on file
  length** (`similarity.ts:167`): a 300k-line file at the parent snapshot is a 30M-
  cell Uint8Array per candidate, ×30 files. **Fix:** anchor-windowed alignment — a
  match requires an exact significant line, so only ±(BLOCK_CAP+slack) windows
  around exact-anchor positions need scanning.

### Medium

- **`busFactorBoard` was O(authors × files) with two allocations per pair**
  (`bus-factor.ts:100`), recomputed per streamed update behind a computed.
  **Fixed in this change:** single pass — a file orphaned by one departure is exactly
  a file whose only active expert is that author.
- **`temporalCloseness` re-sorted the same timestamp array once per pair partner**
  (`team-graph.ts:187`): an author with k co-editors on a file was sorted k times.
  **Fixed in this change:** each author's edit times are sorted once per file.
- **`levenshteinSimilarity` runs the full DP even when the length gap already caps
  similarity below the 0.5 acceptance floor** (`similarity.ts:35`): return early when
  `|n−m| > max/2`; band the rest; reuse scratch arrays.
- **`surprisingCouplings` re-splits every path of every (uncapped) pair per update**
  (`co-change.ts:257,277`): memoize directory segments per path; prefilter by degree
  before allocating.
- **Pair accumulators use string-concat keys and are unbounded**
  (`co-change.ts:106`, `team-graph.ts:281`): interning paths to ints and keying
  numerically cuts pair-map memory 5–10× on big windows.
- **Bot filtering is inconsistent**: `knowledge.ts` filters bot authors,
  `team-graph.ts`/`hotspots.ts`/`co-change.ts` don't — dependabot fabricates
  collaboration ties and churn. Unify on `isBotAuthor`.
- **`relativeTime` constructed `Intl.RelativeTimeFormat` per call**
  (`relative-time.ts:16`), once per visible row across five components.
  **Fixed in this change** (module-level singleton; the locale is fixed).

### Measured non-fix: diff line interning

The obvious optimization — intern lines to integers so the Myers inner loop compares
ints instead of strings — was implemented and benchmarked, then **rejected on the
data**: on the common blame-walk shape (8k lines, ~10% scattered edits, distinct
string objects on both sides) it was ~70% *slower* (1.4 → 2.4 ms/diff) because the
fixed interning pass dominates when D is small and V8's string-equality fast paths
are good; only the rare large-rewrite shape won (164 → 106 ms). Do not re-attempt
without a workload where large-D diffs dominate. The right diff-layer improvements
are instead: emit ops in one pass instead of two (`diff.ts:87–103`, ~40% fewer
allocations), and the `movedLinePairs` indexing above.

### Low / latent

- `squarify` grows rows by spread and rescans per candidate (`treemap.ts:56`) — fine
  at 45 tiles, O(1)-accept fix is ~10 lines when needed.
- `walkLineTrace` computes `changeRegions` twice per step and builds the full
  line map for a 1–5-line range (`line-range.ts:113`, `repo-store.ts:2402–2406`).
- `relatedFiles` scans the full pair list per query (`co-change.ts:142`) — fine at
  current call sites; build an adjacency index if it ever moves into a hover path.
- Duplication: `DEFAULT_MAX_COMMIT_FILES = 25` ×5, union-find ×2, `[...new Set()]`
  dedupe re-done in all five analyses per aggregation, three overlapping whole-file
  similarity APIs (`lineSimilarity`, `fuzzyLineSimilarity`, store joins).

## Layer 4 — Provider layer

### High

- **isomorphic-git's `cache` parameter was never passed** (`local-provider.ts`,
  every call): each `readBlob`/`readCommit`/`readTree`/`log` re-read and re-parsed
  the packfile index from scratch — and blame/trace/Age issue one such call per
  commit. **Fixed in this change:** a per-fs cache object (WeakMap, dies with the
  filesystem handle like the existing log/tree caches) passed to every supporting
  call. This is the single biggest local-repo lever; expect an order of magnitude on
  packed repos.
- **`getCommitFiles` truncated silently on GitLab** (`gitlab-provider.ts:206`): the
  diff endpoint paginates at 20 by default, so any commit touching more files fed
  truncated change lists into co-change, hotspots and the survival walk (files that
  "never die"). **Fixed in this change** (`per_page=100` + page loop). GitHub has the
  same issue at 300 files (`github-provider.ts:266`, pageable to 3,000) and Azure
  DevOps' `/changes` takes `$top/$skip` — both still open.
- **The fetch wrapper + status→error ladder is copy-pasted five times and has
  drifted** (`github-provider.ts:299`, `gitlab-provider.ts:240`,
  `bitbucket-cloud-provider.ts:261`, `bitbucket-server-provider.ts:260`,
  `azd-provider.ts:226`). The worst drift is semantic: **GitLab/Bitbucket/AZD map
  401/403 to `'not-found'`**, and the store treats `'not-found'` as "file
  legitimately absent" (`repo-store.ts:2232` — the survival walk records it as a
  deletion). A token expiring mid-Age-walk silently corrupts the report — the exact
  outcome that code path's comment forbids. **Fix:** add `'auth'` to
  `RepoErrorKind`, map 401/403 to it everywhere, treat it like `'rate-limited'`
  (fail loudly); extract one `RestGitProvider` base with `authHeaders`/`mapStatus`
  hooks — which is then also the single home for `AbortSignal`, `Retry-After`
  parsing and per-URL request dedup.
- **No cancellation anywhere**: zero `AbortController` in `src/`. Stale walks keep
  up to 12 prefetches in flight against GitHub's 60/hr anonymous budget and delay
  the next repo behind the browser's per-host connection limit. **Fix:** thread
  `signal?: AbortSignal` through `GitProvider` methods (~15 lines once the shared
  wrapper exists); the store aborts per load epoch and per analysis run.

### Medium

- **Walk pagination at 30/page**: full-history walks paid 3.3× the round trips and
  rate budget needed. **Fixed in this change:** the self-contained co-change and
  survival walks now page at 100 (`WALK_PAGE_SIZE`); the History panel keeps 30
  (its page numbers are cached and continued across loads).
- **Survival bypasses `commitFilesCache`** (`repo-store.ts:1869` calls the provider
  directly): running Age after "analyze all history" re-fetches every commit's file
  list. Route it through `commitFilesFor`; add keyed in-flight dedup for
  `resolveCommit`.
- **Blob decode duplicated 6× with drift**: `MAX_FILE_SIZE_BYTES` declared six
  times; Bitbucket Server has no pre-fetch size guard at all (downloads oversized
  blobs, then discards). GitHub/GitLab fetch base64 JSON (+33% transfer) and decode
  via a per-char loop on the main thread when both hosts serve raw bytes
  (`Accept: application/vnd.github.raw+json`; `/repository/blobs/:sha/raw`).
  Consolidate into `bytesToRepoFile` in `core/util/decode.ts`.
- **URL-parser toolkit duplicated ×5** (`tryParseHttpUrl`, `decodeSegment`, ssh
  matcher, scheme regex ×7). A `core/git/url-kit.ts` shrinks each parser to its
  path grammar.
- **`resolveRefPath` exists only on GitHub** (`github-provider.ts:122`), yet GitLab
  and Bitbucket also allow `/` in branch names — a
  `gitlab.com/g/p/-/tree/feature/foo/src` URL silently mis-splits today. Both hosts
  have cheap ref-search endpoints.
- **AZD bypasses host-keyed token lookup** (`azd-provider.ts:248` uses
  `tokenFor('azd')` instead of `tokenForSlug`) — breaks the "token per instance"
  contract the moment AZD custom hosts exist.

### Low

- Rate-limit metadata (`Retry-After`, `x-ratelimit-reset`) parsed only by GitHub;
  GitHub's secondary rate limits (403 + `Retry-After`) fall through to `'unknown'`.
- `SHA_PATTERN` defined 3× with different semantics; Bitbucket Cloud reuses the
  page-cap constant `MAX_PAGES` as a recursion **depth** by coincidence
  (`bitbucket-cloud-provider.ts:113`); Bitbucket commits paging by page number vs
  the documented `next`-link contract.
- Provider ordering in `app.config.ts` implicitly decides who wins bare
  `owner/repo` input — no test pins it. A shared contract-test factory (one spec
  suite run against every provider with a fake fetch) plus the base class would make
  a Gitea provider ~150 lines of genuinely new code.

---

## What was fixed in this change

Measured or provably output-identical fixes, all verified against the full suite
(829 tests) and a production build:

| Fix | Impact |
| --- | --- |
| `forceLayout` on flat typed arrays (`force-layout.ts`) | 15–18× measured (18→1.2 ms at n=40, 121→6.4 ms at n=100, 451→26 ms at n=200); Timing slider now drags smoothly |
| isomorphic-git `cache` per fs (`local-provider.ts`, all read calls) | Order-of-magnitude on packed local repos: blame/trace/Age no longer re-parse the pack index per commit |
| Cluster once, filter by size band (`insights-view.ts`) | Cluster-size slider stops running union-find over the full pair list per drag tick |
| Focus effect keyed on file, not state identity (`insights-view.ts`) | Tab no longer snaps back to Coupling every 5 commits during a focus walk |
| Generated-file filter moved to collect time + memoized (`repo-store.ts` walk) | Removes the ~30-regex battery × whole window per pump; snapshot becomes O(1); also removes the `excludedCount` side-channel |
| Survival rename size-ratio prefilter + hoisted joins (`repo-store.ts`) | Refactor commits stop paying full Myers diffs for size-incompatible pairs (output-identical) |
| Macrotask yield every 16 steps in blame + trace walks (`repo-store.ts`) | Fully-cached walks paint their streamed progress instead of freezing the tab |
| `busFactorBoard` single pass (`bus-factor.ts`) | O(authors×files) with per-pair allocations → one pass over files |
| Per-file one-time sort in `computeTeamGraph` (`team-graph.ts`) | k-collaborator hot files: k sorts → 1 per author |
| `WALK_PAGE_SIZE = 100` for co-change + survival walks (`repo-store.ts`) | 3.3× fewer history round trips and rate-limit spend on full walks |
| GitLab `getCommitFiles` pagination (`gitlab-provider.ts`) | Commits with >20 files no longer silently truncated (data correctness for all Insights) |
| `historyFor`/`lastTouch` staleness guards (`repo-store.ts`) | Cross-repo history cache poisoning race closed |
| `Intl.RelativeTimeFormat` singleton (`relative-time.ts`) | Removes a µs-scale ctor per visible row across five components |

## Prioritized backlog

1. **`'auth'` error kind + shared `RestGitProvider` base** — the auth→`'not-found'`
   mapping is a silent data-corruption path today; the base class is also where
   AbortSignal, Retry-After and request dedup land once instead of five times.
2. **Diff-view virtualization** — reuse `file-view`'s windowing; biggest remaining
   user-visible win on large diffs.
3. **Time-throttle streaming publishes** (blame per-step publishes; the co-change
   pump's every-5-commits) and batch the copy-on-write Map writes — the two halves
   of the "walks are quadratic" cliff.
4. **Move `summarizeSurvival` into the analysis worker** (or incrementalize its
   sort) — the last big main-thread stall.
5. **AbortController per load epoch / analysis run** — stop spending rate budget on
   abandoned navigations.
6. **Split `InsightsView` into per-tab components** — unlocks the CD-scope win and
   makes the template duplication mechanical to remove.
7. **Decompose `RepoStore`** around a real cancellation token (extract
   `BlameEngine`, `HistoryLoader`, `InsightsWalker` first — they have the clearest
   seams and the known races/duplication).
8. **`movedLinePairs` indexing + `findBlockOrigin` anchor windows** — the two
   remaining algorithmic cliffs on pathological-but-real inputs.
9. GitHub/AZD `getCommitFiles` paging; survival routed through `commitFilesFor`;
   raw-bytes blob fetches; `resolveRefPath` for GitLab/Bitbucket.
10. Cache eviction budgets (`_files`, `treeCache`, survival lifetimes); blame
    resumption from `processed`.

### Invariants any refactor must preserve

Keyboard shortcuts and their focus/finder guards (`viewer-page.ts:1017`); deep-link
semantics (`ref`/`path`/`at`/`view`/`blame`/`line`/`base`/`insights`/`host`, and
what each navigation clears); remembered UI state keys in localStorage; the blame
walk's three edge-case branches (not-found ⇒ reintroduced-here, binary-before,
moved-line remapping) which are mirrored independently in the survival walk —
extract a shared "attribute one step" helper before touching either; the
`exploreAnyway`/`lastLoadedRef` triangle; `loadBlame`'s termination condition
(history cache length strictly grows per epoch); write-only token inputs on the
loader; and the 24-px row-height assumption shared by file-view and diff-view
scroll math.
