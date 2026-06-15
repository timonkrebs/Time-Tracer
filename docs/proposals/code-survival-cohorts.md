# Proposal — Code survival & age cohorts ("Git of Theseus" for Time Tracer)

**Status:** Draft proposal · **Area:** Insights (`features/viewer/insights-view.ts`) ·
**Roadmap:** extends item 22, _Repository Insights_

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
  readonly bornAt: number;        // ms epoch of the adding commit
  readonly bornYear: number;      // birth cohort bucket
  readonly author: string;        // normalized author of the adding commit
  readonly diedAt: number | null; // ms epoch of the removing commit, or null = alive at HEAD
}
```

- **Cohort stack** = for each time bucket `t`, count lines with `bornAt ≤ t` and
  `(diedAt === null || diedAt > t)`, grouped by `bornYear`.
- **Authorship share** = the same, grouped by `author` (snapshot at `t = now`).
- **Survival curve** = Kaplan–Meier over the lifetimes `diedAt − bornAt`, with `diedAt === null`
  rows treated as **right-censored** at `now − bornAt`.

## Methodology

### 1. Births and deaths from a forward diff walk

Time Tracer already reconstructs line identity in reverse for blame (`runBlame` in
`repo-store.ts`, walking history with `core/util/diff.ts`). Survival needs the same mechanism run
**forward**: walk commits oldest→newest, and for each commit diff every changed file against its
parent. The diff ops give us exactly what we need, positionally — no fragile content matching:

```ts
// per file, maintain a cohort tag for each currently-live line
for (const op of diffOps) {            // DiffOp from core/util/diff.ts
  if (op.kind === 'remove') death(tags[op.oldLine - 1]);          // a line dies
  if (op.kind === 'add')    tags.splice(op.newLine - 1, 0, born); // a line is born
  // 'equal' lines keep their existing tag
}
```

At the end of the walk every tag still in a file's array is a **survivor**, emitted with
`diedAt = null`. This is the same shape of work as `loadAllHistory` + the blame diff-walk, over the
content already cached per `<sha, path>`.

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

Censored lines (alive at `HEAD`) leave the risk set at their censoring age **without** counting as
a death — this is what correctly stops recently-added lines, which simply haven't had time to die,
from dragging the curve down. We report:

- **Code half-life** = the age where `S(t)` first crosses 0.5 (median line lifetime).
- **S(10y)** = survival at ten years, to compare directly with Bernhardsson's ~40%.
- An optional fitted exponential `S(t) = 2^(−t/halfLife)` overlay, plus the dashed benchmark line.

> Equivalence note: `git-of-theseus` aggregates per-cohort survivor counts across history
> snapshots; the line-lifetime formulation above is mathematically equivalent and far cheaper given
> Time Tracer's forward diff walk (one pass, no repeated full-tree blames).

### 4. Observation window / left-truncation

If the walk runs on a **capped** window rather than full history, the oldest lines are
left-truncated (born before the window) and their true age is unknown. The survival curve therefore
**requires the full walk** ("Compute survival — full history", mirroring co-change's _Load all_).
The capped walk powers only the cheap cohort/author snapshot, where truncation is harmless.

## Two-tier design (mirrors the existing capped vs. "Load all" pattern)

| Tier | Trigger | Cost | Delivers |
|------|---------|------|----------|
| **1 — Age snapshot** | default, on tab open | one history-walk per file (= the Owners _folder scan_ over the whole tree, `computeFolderOwnership` without the folder filter) | cohort stack at `HEAD` + authorship share. **No survival curve** (survivors only). |
| **2 — Survival** | explicit "Compute survival (full history)" button | one diff per changed `<sha,path>` across all commits (= `loadAllHistory` + blame walk) | line-lifetime table → full cohort time-series, author-over-time, **Kaplan–Meier curve**. |

Tier 1 is essentially the existing repo-wide blame the Owners panel already performs, re-bucketed
by year instead of summarised per file. Tier 2 is the deep, opt-in pass. Both **stream
progressively** and are **cancelled by navigation** through the same load-sequence guards every
other walk uses.

## Where it lives in the code

Concrete, following the established `hotspots.ts` / `co-change.ts` / `CoChangeState` patterns:

- **`core/util/survival.ts`** (new pure util + `survival.spec.ts`):
  - `kaplanMeier(lifetimes, now)` → `{ points: { ageDays, survival, atRisk, deaths }[], halfLifeDays, survivalAt(days) }`
  - `cohortSeries(lifetimes, { bucket: 'year' })` → stacked series for the area chart
  - `authorSeries(lifetimes, now)` → reuses author normalization from `ownership.ts`
  - `BERNHARDSSON_BENCHMARK = { halfLifeYears: 6, survivalAt10y: 0.40 }`
- **`core/store/repo-store.ts`**: a `_survival` signal + `SurvivalState` (status/scanned/target/
  result/message — same shape as `CoChangeState`) and a `computeSurvival({ all })` walk modelled on
  `walkCoChange`, fetching content per `<sha,path>` through the existing cache and folding diffs into
  the lifetime table. Tier 1 can reuse `computeFolderOwnership`'s blame results unbucketed.
- **`features/viewer/insights-view.ts`**: extend `tab` to `'hotspots' | 'coupling' | 'age'`, add the
  tab button and three SVG charts (stacked-area path generator, 100%-stacked bar, KM step polyline +
  benchmark dashes). Inputs `[survival]`, outputs `(computeSurvival)` / `(computeSurvivalAll)`.
- **`features/viewer/viewer-page.ts`**: wire `[survival]="store.survival()"` and the new outputs into
  `<app-insights-view>`, next to the existing `coChange` / `coupleFocus` bindings.

## Cost, performance, and honesty about limits

- **Tier 1** costs what the Owners folder scan costs over the whole tree — bounded, cached, and
  free for **local repositories** (the isomorphic-git provider has the whole object DB on disk and
  already scans folders automatically).
- **Tier 2** is request-heavy on hosted providers (one content/diff fetch per changed file per
  commit). It is gated behind an explicit button, streams as it goes, and surfaces the same
  "add a token first" guidance the Insights intro already shows for the anonymous 60-req/hr budget.
  **Local repos are the ideal target.** Roadmap item 21 (move blame/Trace walks to a **Web Worker**)
  applies directly — the survival walk should run off the main thread so long histories stay smooth.
- Honest framing in the UI: the curve is "lines tracked through this repo's recorded history";
  renames/moves follow only as far as the diff walk does (a later enhancement could lean on the
  existing rename-candidate machinery to carry cohorts across renames).

## Testing

Following `hotspots.spec.ts` / `co-change.spec.ts` / the local-provider integration tests:

- **`survival.spec.ts`** — hand-built lifetime tables with known answers: the textbook KM example
  (verify step values and censoring), cohort bucketing, a fully-censored table (all alive →
  `S = 1`, no survivorship-bias collapse), median/half-life extraction.
- **Store integration** — build a real in-memory git repo (the project already does this for the
  local provider) with a scripted add/delete pattern and assert the resulting cohort counts and
  survival points.
- **`insights-view.spec.ts`** — tab switching and chart rendering from a fixture `SurvivalState`.

## Phased rollout

1. `core/util/survival.ts` + tests (pure, no UI) — Kaplan–Meier, cohort/author series, benchmark.
2. Tier 1 store walk + **Age** tab with the cohort stack and authorship share (cheap, ships value
   immediately).
3. Tier 2 survival walk + the Kaplan–Meier curve with half-life and the Bernhardsson reference.
4. Move the Tier 2 walk to a Web Worker (with roadmap item 21); optionally carry cohorts across
   renames using the existing candidate search.

## Open questions

- **Default bucket** for cohorts — calendar **year** (matches Git of Theseus) vs. quarter for young
  repos. Proposed: year, auto-switching to quarter when history < ~2 years.
- **Authorship over time** vs. snapshot only — start with the current-snapshot 100%-stacked bar;
  add the time-series stack if it earns the screen space.
- **LOC vs. bytes** — blame is line-based, so cohorts are in **lines**; the treemap's byte-size
  proxy is not reused here.

## Roadmap note

Update README item 22 to list, after the contributor leaderboard and bus-factor map,
"**code survival / age cohorts** (Git-of-Theseus-style cohort stack + Kaplan–Meier survival curve)".
