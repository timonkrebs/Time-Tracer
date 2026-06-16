# Proposal — Code survival & age cohorts ("Git of Theseus" for Time Tracer)

**Status:** ✅ Implemented · **Area:** Insights (`features/viewer/insights-view.ts`) ·
**Roadmap:** extends item 22, _Repository Insights_

> **Implemented** as the Insights **Age** tab. The "Implementation notes" section at the
> bottom records how the shipped code differs from this original sketch — in particular the
> correctness points (merges, in-place moves, deleted files, tip-time censoring) raised in
> review and addressed in the walk.

## Summary

Add a third Insights tab — **Age** — that answers "how long does this codebase's code
actually live?" from the same commit walk the existing tabs use. It surfaces three charts,
modelled directly on Erik Bernhardsson's [`git-of-theseus`](https://github.com/erikbern/git-of-theseus)
and his 2016 essay [_The half-life of code_](https://erikbern.com/2016/12/05/the-half-life-of-code.html):

1. **Cohort stack plot** — total lines over time, stacked into cohorts by the **year each line
   was added**. You watch the repo grow and old cohorts erode.
2. **Authorship share** — the same surface broken down by **author** (current snapshot as a
   100%-stacked bar, optionally over time).
3. **Survival curve** — the probability a line is still present _t_ years after it was added,
   estimated with **Kaplan–Meier**, annotated with the repo's **code half-life** (the median
   line lifetime) and the **Bernhardsson benchmark** (half-life ≈ 6 years; ≈ 40% of lines still
   alive after 10 years) as a dashed reference to compare against.

All three are derived from **one underlying object — a table of line lifetimes** — so a single
analysis pass powers the whole tab. The feature reuses Time Tracer's diff engine
(`core/util/diff.ts`), the streaming capped/"Load all" commit walk (`walkCoChange` in
`repo-store.ts`), the per-`<sha,path>` content cache, and the author-share aggregation already
written for the Owners panel (`core/util/ownership.ts`). The plots are hand-drawn SVG, matching
the treemap and cluster graphs the Insights view already renders with no charting dependency.

## Background: what "Git of Theseus" computes

`git-of-theseus` walks a repository's history and, for every line of code, treats it as a subject
that is **born** when a commit adds it and **dies** when a later commit removes it. Lines still
present at `HEAD` are **alive** (censored — observed up to now, death not yet seen). From that
population it produces `cohorts.json` (lines by birth-year over time → the stack plot),
`authors.json` (the same by author), and `survival.json` (a Kaplan–Meier survival function).

Bernhardsson's finding across many large repositories: code decays slowly. He fit an exponential
and reported a **half-life of roughly 6 years**, with **~40% of lines still present even 10 years
later**. Those numbers are the reference our survival chart is plotted against — a repo whose curve
sits well below the benchmark churns faster than average; one above it is unusually stable.

## The three charts

```
 Cohort stack plot                     Survival curve (Kaplan–Meier)
 lines                                 S(t)
 │            ▓▓▓▓ 2026               1.0│●
 │        ▓▓▓▓████ 2025                  │ ●●               repo  ──
 │     ▓▓██████░░░ 2024               0.5│────●●●───────── median = repo half-life
 │   ████░░░░▒▒▒▒▒ 2023                  │      ●●●●●
 │ ██░░▒▒▒▒▒▒░░░░░ ≤2022    benchmark ·  │·····●·●·●·●····· ~40% @ 10y (Bernhardsson)
 └───────────────────► time             └──────────────────► age (years)
   each band = a birth-year cohort,        step function; censored = lines alive at HEAD
   thinning as its lines are deleted
```

The **authorship share** chart is the cohort plot keyed by author instead of birth-year: a
100%-stacked bar for "who wrote the code that is alive today", reusing `AuthorShare` and the
`disambiguateLabels` colouring already used elsewhere in the view.

## Core idea: one line-lifetime table drives all three

```ts
// core/util/survival.ts  (new — pure, deterministic, store feeds it events)

/** A physical line observed over history: born at a commit, died at another or still alive. */
export interface LineLifetime {
  readonly bornAt: number; // ms epoch of the adding commit
  readonly author: string; // author of the adding commit
  readonly diedAt: number | null; // ms epoch of the removing commit, or null = alive at the tip
}
```

(The birth-year cohort is derived from `bornAt` inside `cohortSeries`, not stored.)

- **Cohort stack** = for each time bucket `t`, count lines with `bornAt ≤ t` and
  `(diedAt === null || diedAt > t)`, grouped by birth year.
- **Authorship share** = the same, grouped by `author` (snapshot at `t = now`).
- **Survival curve** = Kaplan–Meier over the lifetimes `diedAt − bornAt`, with `diedAt === null`
  rows treated as **right-censored** at `tip − bornAt` — where `tip` is the **latest analysed
  commit's time**, not wall-clock now, so an archived or old ref is not read as if its code
  survived until today.

## Methodology

### 1. Births and deaths from a forward diff walk

Time Tracer already reconstructs line identity in reverse for blame (`runBlame` in
`repo-store.ts`, walking history with `core/util/diff.ts`). Survival needs the same mechanism run
**forward**: walk the mainline oldest→newest, and for each commit diff every changed file against
the running snapshot. The diff ops give us exactly what we need, positionally — no fragile content
matching. The per-file tag array is **rebuilt** each step (so removed lines leave it, not just get
flagged dead):

```ts
// per changed file: diff the running snapshot (oldLines/oldTags) against the new content
const ops = diffLines(oldLines, newLines);
const moved = movedLinePairs(ops); // an in-file block move: remove+add of the same line
const movedOld = new Set(moved.values());
const newTags: Tag[] = [];
for (const op of ops) {
  if (op.kind === 'equal')
    newTags.push(oldTags[op.oldLine - 1]); // survives, keep tag
  else if (op.kind === 'remove') {
    if (movedOld.has(op.oldLine)) continue; // moved, not dead
    death(oldTags[op.oldLine - 1]); // a line dies (its tag is dropped — it is not in newTags)
  } else {
    const from = moved.get(op.newLine);
    newTags.push(from !== undefined ? oldTags[from - 1] : bornTag); // carried move, or genuinely born
  }
}
files.set(path, { lines: newLines, tags: newTags });
```

At the end of the walk every tag still in a file's array is a **survivor**, emitted with
`diedAt = null`. This is the same shape of work as `loadAllHistory` + the blame diff-walk, over the
content fetched per `<sha, path>`.

A few cases the loop above gets right (and that a naïve version does not):

- **In-place moves** reuse `movedLinePairs` exactly as blame does, so a pure refactor carries the
  line's age instead of resetting it (remove+add of the same content is one surviving line, not a
  death plus a birth).
- **Deleted files** never fetch — `newLines = []`, so the diff is all-removes and every remaining
  tag in that file dies. A not-found blob at the commit is treated the same way.
- **Merges / branches**: the walk follows the **first-parent chain** (a clean linear sequence of
  tree states), so side-branch commits fold into the merge that brings them to the mainline instead
  of being applied to one mutable tree out of order. Because each step diffs against the file's
  _actual_ content at that commit, the snapshot also self-corrects rather than drifting. The
  trade-off is **authorship**: lines that enter the mainline through a true merge commit are
  credited to that merge (its author and date), not the original side-branch commit. First-parent
  keeps the lifetime structure correct; recovering the real origin of merged lines would need a
  per-merge blame of the second parent (a heavier, Git-of-Theseus-style pass), so it is tracked as
  future work. Squash- and rebase-merge workflows are unaffected (their mainline commit _is_ the
  author).

### 2. Why a `HEAD` blame is not enough (survivorship bias)

A blame of the current tree only ever sees **survivors** — it has no record of lines that were
added and later deleted. Estimating a survival curve from survivors alone is textbook survivorship
bias: it would conclude `S(t) = 1` everywhere ("nothing ever dies"). Real Kaplan–Meier **requires
observing deaths**, which is why the survival curve needs the full forward walk, not a snapshot.
The cohort/author snapshot, by contrast, is _defined_ on survivors and a single `HEAD` blame is
exactly right for it — which motivates the two-tier design below.

### 3. Kaplan–Meier estimator

Order the distinct death ages `t₁ < t₂ < …`. With `dᵢ` = deaths at `tᵢ` and `nᵢ` = lines **at
risk** (lifetime `≥ tᵢ`, i.e. still alive and observed up to `tᵢ`, censored survivors included):

```
S(tᵢ) = S(tᵢ₋₁) · (1 − dᵢ / nᵢ)          S(0) = 1
```

Censored lines (alive at the tip) leave the risk set at their censoring age **without** counting as
a death — this is what correctly stops recently-added lines, which simply haven't had time to die,
from dragging the curve down. We report:

- **Code half-life** = the age where `S(t)` first crosses 0.5 (median line lifetime). It is
  **nullable**: a young or very stable repo whose curve never reaches ½ has no observed median,
  rendered as "not reached" rather than a fabricated number.
- **S(10y)** = survival at ten years, to compare directly with Bernhardsson's ~40%.
- The dashed benchmark reference line (two anchors: ½ at 6 yr, 0.4 at 10 yr).

> Equivalence note: `git-of-theseus` aggregates per-cohort survivor counts across history
> snapshots; the line-lifetime formulation above is mathematically equivalent and far cheaper given
> Time Tracer's forward diff walk (one pass, no repeated full-tree blames).

### 4. Observation window / left-truncation

A **capped** window left-truncates the oldest lines (born before the window, so their true age and
even their birth is unknown) — which would silently mis-bucket or drop old live code. Rather than
carry that hazard, the feature shipped as a **single full-history walk** (no capped tier): all
three charts come from the same complete lifetime table, so there is no truncation to correct for.
It is the only statistically honest choice for the survival curve, and it keeps the cohort/author
snapshots exact too.

## A single full-history walk (as built)

The two-tier "cheap snapshot + opt-in deep walk" split in the original sketch was dropped: a capped
snapshot tier can't bucket pre-window live code (see Observation window above), and the cohort
time-series and survival curve both need the full lifetime table anyway. So there is **one**
analysis — `RepoStore.computeSurvival()` — triggered by an explicit **"Analyze code age &
survival"** button. It walks the whole mainline, **streams** a recomputed report every
`SURVIVAL_RECOMPUTE_EVERY` commits, and is **cancelled by navigation** through the same
load-sequence guards every other walk uses. All three charts are derived from its lifetime table.

## Where it lives in the code (as built)

Following the established `hotspots.ts` / `co-change.ts` / `CoChangeState` patterns:

- **`core/util/survival.ts`** (pure util + `survival.spec.ts`):
  - `kaplanMeier(lifetimes, now)` → `{ points: { ageDays, survival, atRisk, deaths }[], totalLines, deaths, censored, halfLifeDays }`
  - `survivalAt(curve, ageDays)` → `S(t)` read off the step function
  - `cohortSeries(lifetimes, { now, samples, maxBands })` → stacked per-band series (oldest folded into a `≤YYYY` band)
  - `authorShares(lifetimes, { limit })` → share of the **alive** lines by author (tail folded into "Others")
  - `summarizeSurvival(lifetimes, { now, … })` → the `SurvivalReport` the store publishes
  - `CODE_HALF_LIFE_BENCHMARK = { halfLifeYears: 6, survivalAtTenYears: 0.4, points: […] }`
- **`core/store/repo-store.ts`**: a `_survival` signal + `SurvivalState`
  (`status: 'reading' | 'computing' | 'ready' | 'error'`, `scanned`, `total`, `report`, `message`),
  `computeSurvival()` (the first-parent forward walk) and `clearSurvival()`. Content is fetched per
  `<sha,path>` directly (bypassing the UI file cache so a full walk doesn't flood it).
- **`features/viewer/insights-view.ts`**: `tab` extended to `'hotspots' | 'coupling' | 'age'`, the
  **Age** tab, and three hand-drawn SVG charts (KM step polyline + dashed benchmark, stacked-area
  cohorts, 100%-stacked author bar). Input `[survival]`, output `(computeSurvival)`.
- **`features/viewer/viewer-page.ts`**: `[survival]="store.survival()"`, `(computeSurvival)` and a
  Reset that clears co-change **and** survival, next to the existing `coChange` / `coupleFocus`.

## Cost, performance, and honesty about limits

- The walk is request-heavy on hosted providers (one content fetch per changed file per commit). It
  is gated behind an explicit button, streams as it goes, and the intro repeats the "add a token
  first" guidance the Insights view already shows for the anonymous 60-req/hr budget. **Local repos
  are the ideal target** — the isomorphic-git provider has the whole object DB on disk.
- Roadmap item 21 (move blame/Trace walks to a **Web Worker**) applies directly and is the natural
  next step so long histories stay smooth.
- Honest framing: the curve tracks "lines through this repo's recorded mainline". Cross-file
  renames are carried when the provider reports `previousPath`; a later enhancement could lean on
  the existing rename-candidate machinery to chase the rest.

## Testing (as built)

- **`survival.spec.ts`** — a hand-verified KM example (step values + censoring), cohort bucketing
  and `≤YYYY` folding, a fully-censored table (all alive → `S = 1`, no survivorship-bias collapse),
  half-life extraction and the benchmark figures.
- **`repo-store.spec.ts`** — a scripted add/edit/trim history through the `FakeProvider` asserting
  the resulting births, deaths, censored survivors and author shares.
- **`insights-view.spec.ts`** — the Age tab renders the three charts from a fixture `SurvivalState`,
  shows progress while walking, and emits the analysis from the cold start.

## Implementation notes — review resolutions

Points raised in two rounds of automated review, and how the shipped walk handles each:

| Concern                              | Resolution                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Capped Tier-1 snapshot truncation    | Dropped the capped tier — **one full-history walk** drives every chart, so no pre-window line is mis-bucketed.                             |
| Merge/branch ordering                | Walk the **first-parent chain**; parents are **resolved on demand** (`resolveCommit`) when a provider omits them (Azure DevOps).           |
| Removed line left in the live array  | Tags are **rebuilt** from the diff ops, so a removed line is recorded dead **and** absent from the next snapshot.                          |
| In-place moves reset age             | Reuse `movedLinePairs` (as blame does): a moved block carries its tag — no death, no rebirth.                                              |
| Deleted files                        | No fetch for a removal (and a not-found blob is treated as empty), so the all-removes diff kills every remaining tag.                      |
| Half-life when median not observed   | `halfLifeDays` is **nullable**; the UI renders "not reached".                                                                              |
| Censoring date                       | Survivors are censored at the **tip commit's time**, not wall-clock now.                                                                   |
| Blob fetch error ≠ deletion          | Only an expected `not-found` maps to empty; rate-limit/network errors **re-throw** so the walk fails loudly, not corruptly.                |
| `getCommitFiles` failure swallowed   | No longer caught — a provider failure mid-walk **surfaces as an error** (with the partial report) instead of a stale "ready".              |
| Copied files inherit age             | A `copied` change is **new births** at the copy commit; only a rename carries the source's tags (and removes the source).                  |
| 10-year survival extrapolated        | `maxObservedAgeDays` gates it — a history shorter than 10 yr shows **"unobserved"** rather than a flattering extrapolated number.          |
| Non-monotonic commit dates           | Commit times are **clamped monotonically** along the chain, so a rebased/backdated commit can't record `diedAt < bornAt`.                  |
| Same-commit rename + recreate        | Each commit is computed against a **pre-commit snapshot** with staged writes (deletes before sets), so `a→b` plus a new `a` stay distinct. |
| Size-guarded blobs counted as deaths | A `too-large`/binary blob stops tracking the file **without** recording deaths (no false mass-deaths for big vendored files).              |

## Open questions / future work

- **Cohort bucket** is calendar **year**; quarter-bucketing for very young repos is a possible
  refinement.
- **Authorship over time** — shipped as the current-snapshot 100%-stacked bar; a time-series stack
  could be added if it earns the screen space.
- **`getCommitFiles` pagination** — GitHub's commit endpoint caps the `files` array at 300 and
  paginates beyond it, while the provider reads only the first page. A commit touching >300 files
  (mass imports/vendoring) is rare, but for full fidelity `getCommitFiles` should exhaust
  pagination or signal truncation; this is a **pre-existing, cross-cutting** provider concern
  (co-change and rename detection share it), so it is tracked as a follow-up rather than folded in
  here.
- **Merge-commit authorship** — a consequence of the first-parent walk: lines merged into the
  mainline through a true merge commit are credited to that merge's author/date, not the original
  side-branch commit, which can skew the "% by author" chart and birth years for merge-commit-heavy
  repos (squash/rebase workflows are unaffected). Recovering the true origin needs a per-merge blame
  of the second parent — a heavier follow-up that trades request cost for attribution fidelity, and
  the opposite direction from the first-parent choice that keeps the lifetime structure correct.
- **Web Worker** offload (roadmap item 21) and **carrying cohorts across renames** via the existing
  candidate search remain the natural follow-ups.

## Roadmap note

README item 22 now lists, alongside the contributor leaderboard and bus-factor map,
"**code survival / age cohorts** (Git-of-Theseus-style cohort stack + Kaplan–Meier survival curve)".
