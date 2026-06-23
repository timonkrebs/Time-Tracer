# 🧹 Decluttery Backlog — Time Tracer

A prioritized cleanup backlog from a full-codebase review (≈21k LOC source, ≈12k test).
Each item has a stable ID so it can be picked off one at a time. Check items off as
they land.

**Overall health: very good.** The codebase is unusually disciplined — **0** `TODO/FIXME/HACK`,
**0** stray `console.*`/`debugger`, **0** `any` types, **0** `@ts-ignore`/`eslint-disable`,
no orphan source files, maximal `tsconfig` strictness, strong test coverage, and genuinely
defensive async/SSRF handling. The debt that exists is concentrated in **a few oversized
files** and in **duplication that has begun to drift**, not in rot. Most items below are safe,
incremental cleanups; the big structural ones are flagged to do deliberately behind the
existing tests.

> The three largest files — `insights-view.ts` (3,689), `repo-store.ts` (2,947) and
> `viewer-page.ts` (1,632) — are **~39% of all source** in 3 files. That concentration is the
> headline finding.

Legend — **Safety:** ✅ safe to fix now · ⚠️ do deliberately / behind tests · ⏳ needs a
decision or consumer sweep first.

---

## 🔴 Critical

> High-impact maintainability/security. None are live bugs today, but each is actively making
> the code harder to change or leaves a gap that will hurt later.

### C1 — Split the `insights-view.ts` god component
- [ ] **Status: open**
- **Where:** `src/app/features/viewer/insights-view.ts` (3,689 lines; **~1,840-line inline
  template**, lines 439–2278; 214 class members; 7 tabs — hotspots, coupling, team, knowledge,
  busfactor, wrapped, age — in one component).
- **Why it matters:** Each tab has its own SVG visualization, sliders, tooltips, hover state and
  ~dozen computeds, all interleaved in one class and one template. Touching any single chart
  means scrolling a 3.7k-line file; merge conflicts are near-guaranteed; the component can't be
  tested or lazy-loaded per tab.
- **Recommendation:** Extract one child component per tab (`HotspotsTab`, `CouplingTab`,
  `TeamTab`, `KnowledgeTab`, `BusFactorTab`, `WrappedTab`, `AgeTab`), each taking its slice of
  state as inputs. `InsightsView` keeps the tab strip + shared filters and composes them. Pull
  the SVG layout constants and `squarify`/`layout` helpers into the relevant tab.
- **Safety:** ⚠️ Large refactor — do incrementally (one tab at a time), leaning on
  `insights-view.spec.ts`.

### C2 — Decompose the `repo-store.ts` god service
- [ ] **Status: open**
- **Where:** `src/app/core/store/repo-store.ts` (2,947 lines). One service owns ~10 concerns:
  load lifecycle, file cache, history, blame, diff, line-trace, hunk-origin search, folder
  ownership, co-change/hotspots/team/knowledge, survival, rename candidates. It carries **7
  separate cancellation mechanisms** (`loadSeq` + `traceRun`/`originRun`/`folderRun`/
  `coChangeRun`/`focusRun`/`survivalRun`/`blameRuns`), the stale-response guard appears **47×**,
  and the copy-on-write map setter (`new Map(this._x()); next.set(...); signal.set(next)`)
  repeats 6× plus 4 `set*State` helpers. The `computeSurvival` method alone is ~420 lines.
- **Why it matters:** This is the gravity well of the app — almost every change goes through it,
  and its size + the hand-rolled per-feature cancellation make it error-prone to extend.
- **Recommendation:** (1) Extract a small `RunToken`/`createRunGuard()` helper to replace the 7
  bespoke counters. (2) Extract a generic `patchMapSignal(signal, key, value)` for the
  copy-on-write setters. (3) Split feature areas into collaborating services (e.g.
  `BlameStore`, `TraceStore`, `InsightsStore`, `SurvivalStore`) behind the existing public
  surface. (4) Break `computeSurvival` into named steps.
- **Safety:** ⚠️ Large refactor — `repo-store.spec.ts` is the guardrail; do it in stages, start
  with the two helper extractions (low risk, immediate readability win).

### C3 — Collapse the cross-provider REST/error duplication (it has already drifted)
- [ ] **Status: open**
- **Where:** the `request`/`fetchChecked` blocks in all 5 network providers —
  `github-provider.ts:299-361`, `gitlab-provider.ts:240-284`, `azd-provider.ts:242-294`,
  `bitbucket-cloud-provider.ts:270-307`, `bitbucket-server-provider.ts:269-309` (~230 near-
  identical lines), plus the `{ notFound; notFoundKind }` message object threaded through every
  method.
- **Why it matters:** The duplication has **already produced inconsistent behavior** (the exact
  hazard it warns of): GitHub maps `401 → 'unknown'`, but GitLab/AZD/Bitbucket map
  `401/403 → 'not-found'`; only GitHub handles `409 → 'empty-repo'` and parses the rate-limit
  reset header. (The `not-found` miscategorization also has a correctness tail — see **M9**.)
- **Recommendation:** Extract a shared `GitHttpClient`/`fetchJson({ auth, statusMap })`. Each
  provider supplies only its auth-header builder and any status overrides; the 401/403/404/409/
  429 ladder lives in one place. Fold M5's `MAX_FILE_SIZE_BYTES`/`mapCommit`/pagination into the
  same pass.
- **Safety:** ⚠️ Sizeable but mechanical; the `*-provider.spec.ts` suite covers it. Do one
  provider at a time.

### C4 — Add HTTP security headers (and a staged CSP)
- [ ] **Status: open**
- **Where:** no `public/_headers` / `netlify.toml` exists; only `public/_redirects`.
- **Why it matters:** The app renders user-controlled repository content (filenames, commit
  messages, author names, file bodies) into the DOM and talks to many third-party origins. Angular's
  escaping is the primary defense and is solid (no `innerHTML` writes, no `bypassSecurityTrust`),
  but there is **no defense-in-depth**: no CSP, no `nosniff`, no `frame-ancestors`/clickjacking
  protection.
- **Recommendation:** Add a Netlify `public/_headers` (or `netlify.toml`) with
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` now.
  Then stage a CSP in **report-only** first — it must allow the inline theme script in
  `src/index.html:12` (hash it), `worker-src 'self' blob:` for the analysis worker, and a broad
  `connect-src` (hosts are user-supplied, so likely `https:`).
- **Safety:** ✅ for the non-CSP headers · ⚠️ stage the CSP report-only before enforcing.

---

## 🟡 Medium

### M1 — Trim the `viewer-page.ts` component + extract a navigate helper
- [ ] **Status: open**
- **Where:** `src/app/features/viewer/viewer-page.ts` (1,632 lines; **9 constructor effects**;
  **16** `router.navigate([], { relativeTo, queryParams, queryParamsHandling: 'merge' })` blocks).
- **Why it matters:** The 16 repeated navigate blocks differ only in their `queryParams`; the 9
  effects orchestrate load/select/diff/blame/history with subtle ordering. It's a lot of surface
  for one component.
- **Recommendation:** Add a private `mergeQuery(params)` helper for the navigate boilerplate;
  consider extracting the header bar and the time-travel stepper toolbar into child components.
- **Safety:** ✅ navigate helper is mechanical · ⚠️ component split needs care with the effects.

### M2 — One typed `storage.ts` for the localStorage boilerplate
- [ ] **Status: open**
- **Where:** **12** `restore*`/`persist*` try/catch helpers across `viewer-page.ts`,
  `core/theme/theme.ts`, `core/git/access-tokens.ts`, `core/store/recent-repos.ts`.
- **Why it matters:** Every reader/writer re-implements the same `try { localStorage… } catch {}`
  guard; easy to forget the guard (throws in private mode) on the next one.
- **Recommendation:** A tiny `storage.ts` exposing `readString/readBool/readNumber/write/remove`
  with the guard built in; callers shrink to one line each.
- **Safety:** ✅ Safe.

### M3 — Shared `git/url-util.ts` for the repeated URL parsers
- [ ] **Status: open**
- **Where:** `decodeSegment` (×6), `tryParseHttpUrl` (×5), `stripTrailingSlash` (×3) and the
  `^[A-Za-z0-9]…$` segment regex (×3) reimplemented across the 7 `*-url.ts` files and providers.
- **Why it matters:** These are parsing/security primitives; a fix to one copy silently misses the
  others.
- **Recommendation:** Move them to `core/git/url-util.ts`; the `*-url.spec.ts` suite covers behavior.
- **Safety:** ✅ Safe — pure helpers, well tested.

### M4 — Shared `commit-window.ts` for the analysis recency math
- [ ] **Status: open**
- **Where:** `co-change.ts`, `hotspots.ts`, `knowledge.ts`, `forecast.ts`, `team-graph.ts` each
  re-implement the same skeleton: `DAY_MS = 86_400_000` (×5), `DEFAULT_MAX_COMMIT_FILES = 25`
  (×5), the decay kernel `2 ** (-ageDays / halfLife)` (×4), and `[...new Set(commit.files)]` (×5).
- **Why it matters:** A change to "what counts as a mega-commit" or the decay shape must be made
  in five places and is easy to get subtly inconsistent.
- **Recommendation:** Extract `DAY_MS`, `DEFAULT_MAX_COMMIT_FILES`, `recencyWeight(ageDays,
  halfLife)`, and a `walkCommitFiles(commits, maxCommitFiles)` generator.
- **Safety:** ⚠️ Hot paths feeding the worker; refactor behind the dense existing specs.

### M5 — De-duplicate provider constants & shapers
- [ ] **Status: open**
- **Where:** `MAX_FILE_SIZE_BYTES = 2_000_000` defined 6× (only 2 exported), `mapCommit`
  reimplemented 6× (each with `summary = message.split('\n',1)[0]`, `?? 'Unknown'`, `?? null`),
  and the tree-pagination + empty-repo-guard skeleton 4×.
- **Why it matters:** App-wide policy (max file size) lives in six files; commit shaping drifts.
- **Recommendation:** Hoist one shared `MAX_FILE_SIZE_BYTES`, a `buildCommitInfo(...)` shaper, and
  a `paginate(fetchPage, { maxPages })` helper. Natural companion to **C3**.
- **Safety:** ✅ Safe; fold into the C3 pass.

### M6 — Factor the repeated history-walk + map-setter logic in `repo-store.ts`
- [ ] **Status: open**
- **Where:** `runBlame` (`repo-store.ts:949`) and `walkLineTrace` (`:2254`) both walk history
  pairwise with `splitLines`/`diffLines`/`movedLinePairs`; `setFileState`/`setDiffState`/
  `setBlameState`/`setRenameState` (`:2880-2902`) are the same copy-on-write map write.
- **Why it matters:** The two walks encode the same "follow lines back through versions" idea
  twice; a fix to one (e.g. binary/deleted-at-older handling) must be mirrored.
- **Recommendation:** Extract a shared pairwise history-walk primitive and a generic
  `patchMapSignal`. Pairs with **C2**.
- **Safety:** ⚠️ Behind `repo-store.spec.ts`.

### M7 — Consolidate UI formatting & the blame-gutter cell
- [ ] **Status: open**
- **Where:** `rangeLabel` (×4: `file-view.ts:459`, `diff-view.ts:814`, `file-history.ts:544`,
  `trace-export.ts:24`), `formatBytes` (×2: `file-view.ts:34`, `insights-view.ts:157`), basename
  hand-rolled (×5+), `percent`/`pct` with clashing return types, the blame-gutter cell template
  (×3: `file-view.ts:217`, `diff-view.ts:323` & `:384`), and `abbrev/when/date` wrappers around
  `relative-time` utils.
- **Why it matters:** Many small clones that must agree (the en-dash in range labels, byte units,
  truncation/a11y in the gutter cell) and will drift.
- **Recommendation:** Move `formatRangeLabel`/`formatBytes`/`basename`/`toPercent` into
  `core/util`; extract a presentational `BlameGutterCell` component; call the time utils directly.
- **Safety:** ✅ Safe — pure, identical semantics.

### M8 — Extract a `TokenField` from `loader-page.ts`
- [ ] **Status: open**
- **Where:** `src/app/features/loader/loader-page.ts` (800 lines) — four near-identical ~40-line
  token blocks (GitHub/GitLab/Bitbucket/Azure), `:171-343`.
- **Why it matters:** The four blocks differ only by id/placeholder/help; the inline template is
  large and mixes landing page + token vault + custom-instance form.
- **Recommendation:** A `TokenField` child (or `@for` over a provider-config array); optionally
  split the custom-instance form out.
- **Safety:** ✅ Safe behind `loader-page.spec.ts`.

### M9 — Stop reporting auth failures as `not-found`
- [ ] **Status: open**
- **Where:** `gitlab-provider.ts:266`, `azd-provider.ts:282`, `bitbucket-cloud-provider.ts:298`,
  `bitbucket-server-provider.ts:297` map `401/403 → 'not-found'` (GitHub uses `'unknown'`).
- **Why it matters:** `kind` drives store logic — e.g. `runBlame`/`walkLineTrace`/`survivalNewLines`
  treat `not-found` as "file absent here" and **silently truncate** the walk. A token revoked
  mid-session would read as a missing file rather than an auth error. (Low frequency, but a real
  correctness tail of **C3**.)
- **Recommendation:** Add an `auth`/`forbidden` `RepoErrorKind`, map 401/403 to it consistently,
  and surface a "check your token" message; audit the `kind === 'not-found'` consumers.
- **Safety:** ⏳ `RepoErrorKind` is consumed across store + UI — needs a consumer sweep + tests.

### M10 — Add a lint/format gate to CI
- [ ] **Status: open**
- **Where:** `package.json` has no `lint` script; `prettier@3.8.1` is a devDependency but **never
  invoked**; `.github/workflows/ci.yml` runs only build + tests.
- **Why it matters:** Formatting and lint regressions can land freely despite the strict tsconfig.
- **Recommendation:** Add `"format:check": "prettier --check ."` (+ a `.prettierignore`) and a CI
  step; optionally add `angular-eslint` + `ng lint`. Run one `prettier --write .` first so the
  gate goes green on day one.
- **Safety:** ✅ add script now · ⏳ make it blocking only after the tree is confirmed clean.

### M11 — Service-worker cache version never bumps
- [ ] **Status: open**
- **Where:** `public/sw.js:14` (`VERSION = 'v1'`); eviction runs only on version change (`:43-51`).
- **Why it matters:** With `outputHashing: all`, every deploy emits new hashed files;
  `staleWhileRevalidate` caches each one but old versions are **never purged**, so the
  `time-tracer-v1` cache grows unbounded across deploys.
- **Recommendation:** Tie `VERSION` to the build hash (or bump per release) and/or prune the
  runtime cache.
- **Safety:** ✅ Self-contained worker change.

### M12 — Standardize date parsing
- [ ] **Status: open**
- **Where:** `relative-time.ts:12,30` use `new Date(iso)`; `ownership.ts:99` uses
  `Date.parse(...) || 0` (conflates epoch-0 with unparseable); everything else uses guarded
  `Date.parse`.
- **Why it matters:** Mixed strategies for the same provider timestamps are a latent inconsistency
  (a string one path accepts and another rejects renders differently).
- **Recommendation:** Use guarded `Date.parse` everywhere; in `summarizeOwnership` align the
  NaN handling with `computeOwnershipRisk`.
- **Safety:** ✅ Safe (tightens malformed-input handling); pin against `ownership.spec.ts`.

### M13 — File-finder modal: focus trap + restoration
- [ ] **Status: open**
- **Where:** `src/app/features/viewer/file-finder.ts:36-45,187` — `role="dialog" aria-modal` and
  input autofocus, but Tab is not trapped and focus isn't restored to the trigger on close.
- **Why it matters:** Keyboard/screen-reader users can tab into the obscured page behind the
  backdrop, and lose their place when the overlay closes — core modal expectations.
- **Recommendation:** Trap Tab/Shift-Tab within the panel; capture `document.activeElement` on
  open and restore it on close.
- **Safety:** ✅ Safe — self-contained, additive.

### M14 — Two small robustness gaps (size guard + worker hang)
- [ ] **Status: open**
- **Where:** (a) `azd-provider.ts` `getFile`/`getFileAtRef` guard on `entry.size`, which Azure
  DevOps often omits, with **no post-download size check** (Bitbucket cloud/server re-check
  `bytes.length`). (b) `analysis.worker.ts:12-15` `onmessage` has no try/catch — an
  `aggregateInsights` throw never posts back, so the Insights request **hangs forever** (the
  runner only resolves on message; `onerror` covers construction errors, not handler throws).
- **Why it matters:** (a) an unreported-size blob can be downloaded/decoded in full; (b) a single
  bad commit could freeze the Insights tab.
- **Recommendation:** (a) add a post-fetch `bytes.length > MAX → too-large` check; (b) wrap the
  handler and post an error envelope the runner turns into a rejection / on-thread fallback.
- **Safety:** ✅ Both additive.

### M15 — Split mixed-concern view files
- [ ] **Status: open**
- **Where:** `ownership-panel.ts` declares **2 components** in one file; `diff-view.ts` (898) and
  `file-view.ts` (526) each carry ~500-line templates combining toolbar + loading/error/empty/
  binary/too-large states + rendering, with near-identical toolbars and the duplicated gutter
  (see **M7**).
- **Why it matters:** Long mixed templates are hard to scan and are the magnet for the M7 clones.
- **Recommendation:** Give each component its own file; extract the shared History/Blame toolbar
  and the skeleton/error blocks.
- **Safety:** ✅ file split is mechanical · ⚠️ template extraction behind specs.

---

## 🟢 Nice-to-have

### N1 — Remove dead exports
- [ ] **Status: open** — `changeRegionRange` (`line-range.ts:98`, **zero** references) ·
  `hunkChangedRange` (`line-range.ts:309`, spec-only) · `instanceHostname` (`host-url.ts:53`,
  spec-only). Delete (and their spec blocks). **Safety:** ✅ / ⏳ confirm `hunkChangedRange` isn't a
  planned API.

### N2 — copy-button feedback
- [ ] **Status: open** — `copy-button.ts:21-24` "Copied!" isn't announced (`aria-live`); `:41`
  swallows copy failures with no user feedback. Add a polite live region + a brief "Couldn't copy"
  state. **Safety:** ✅

### N3 — Heat popup is hover-only
- [ ] **Status: open** — `file-tree.ts:144-147,174-183` shows the hotspot explanation on
  `mouseenter` over a non-focusable `<span>`; keyboard/touch can't open it (an `aria-label`
  summary mitigates). Make it focusable / show on focus. **Safety:** ✅

### N4 — Disable Angular CLI analytics
- [ ] **Status: open** — `angular.json:6` opts the workspace into CLI telemetry — at odds with the
  "nothing leaves your machine" positioning. Set `"analytics": false`. **Safety:** ✅

### N5 — Project metadata tidy
- [ ] **Status: open** — package name `time-trace-repo-viewer` ≠ "Time Tracer"; `version: 0.0.0`;
  no `netlify.toml`; no `.nvmrc`/`engines`. Align name (touches several `angular.json` build
  targets), add `.nvmrc`/`engines: node >=22`, and a `netlify.toml` (natural home for **C4**'s
  headers). **Safety:** ⚠️ name change touches multiple targets — do together.

### N6 — Small util polish
- [ ] **Status: open** — `force-layout.ts:106` `(k*k)/dist/dist` → `/(dist*dist)` (reads like a
  typo) · `image-export.ts:163` deprecated `unescape` → `TextEncoder` base64 · two union-find
  impls (`co-change.ts:186`, `team-graph.ts:386`) → one generic · `couplingConfidence`
  (`co-change.ts:76`) can return a slight negative → `Math.max(0,…)` · `splitLines` (`diff.ts:56`)
  normalizes `\r\n` but not lone `\r` · `temporalCloseness` (`team-graph.ts:185`) re-sorts per
  pair → pre-sort once. **Safety:** ✅ (the team-graph sort needs a perf/spec check ⚠️).

### N7 — Provider polish
- [ ] **Status: open** — `git-provider.ts:24` doc says "unauthenticated APIs" (stale; PATs now
  attach) · `bitbucket-server-provider.ts:157` `fetchRaw` derives its base from `webBase` not the
  shared `apiBase` path (host is centrally validated, so not exploitable — but two code paths to
  keep in sync) · bitbucket id asymmetry (`bitbucket` vs `bitbucket-server`) · AZD rejects
  abbreviated SHAs (`SHA_PATTERN` requires 40 hex). **Safety:** ✅ docs/fetchRaw · ⏳ id rename
  (persisted in recents).

### N8 — Add focused unit specs
- [ ] **Status: open** — `recent-repos.ts` (localStorage parse/validate/dedup/cap) and
  `bitbucket-auth.ts` (Basic-vs-Bearer branching) have real logic and no spec. Small, pure, high
  value. **Safety:** ✅

### N9 — Consistency nits
- [ ] **Status: open** — History/Blame button order differs between `file-view` (Blame, History)
  and `diff-view` (History, Blame) · `LINE_HEIGHT_PX = 24` is also inlined as a magic `24` in
  templates (`file-view.ts:208-209,273-274`) · `file-history.ts:510-523` derives rename sub-state
  via getter methods instead of `computed` · `EMPTY_FORECAST` (`analysis.ts:47`) duplicates
  `forecast.ts`'s private `EMPTY`. **Safety:** ✅

---

## How to use this backlog
Pick an item by ID (e.g. "do M3"). On completion, check its box, set **Status: done**, and the
list is redisplayed for the next pick. Suggested low-risk warm-ups that pay off immediately:
**N1** (delete dead code), **M3** (URL util), **M2** (storage util), **M7** (UI formatting) — then
graduate to the structural **C1/C2/C3**.
