/**
 * Code survival & age cohorts — "Git of Theseus" for Time Tracer.
 *
 * Every physical line of code is treated as a subject that is **born** when a
 * commit adds it and **dies** when a later commit removes it; lines still
 * present at the analysed tip are **alive** (right-censored — observed up to
 * now, death not yet seen). From that population — a table of {@link LineLifetime}
 * rows produced by the store's forward diff walk — three views are derived:
 *
 * - {@link cohortSeries}: total lines over time, stacked by the year each line
 *   was added (the stack plot you watch grow and erode);
 * - {@link authorShares}: the share of the code alive today by author;
 * - {@link kaplanMeier}: the probability a line survives to age _t_, estimated
 *   with the Kaplan–Meier method used for medical survival analysis, from which
 *   the repository's **code half-life** (median line lifetime) falls out.
 *
 * Pure and deterministic given `now`, so it stays decoupled from the store and
 * is easy to test; the store feeds it the lifetimes it has walked.
 *
 * Modelled on Erik Bernhardsson's git-of-theseus and his 2016 essay
 * "The half-life of code" — see {@link CODE_HALF_LIFE_BENCHMARK}.
 */

const DAY_MS = 86_400_000;
/** Julian year, so a "10 year" age lines up with the calendar regardless of leap years. */
export const DAYS_PER_YEAR = 365.25;

/**
 * One physical line observed across history: born at a commit, and either died
 * at a later commit or is still alive at the observation tip (`diedAt === null`,
 * i.e. right-censored).
 */
export interface LineLifetime {
  /** ms epoch of the commit that added the line. */
  readonly bornAt: number;
  /** ms epoch of the commit that removed it, or null when it is still present. */
  readonly diedAt: number | null;
  /** Author of the adding commit, for the authorship breakdown. */
  readonly author: string;
}

// ───────────────────────────── Kaplan–Meier ─────────────────────────────

/** One step of the survival step-function. */
export interface SurvivalPoint {
  /** Age (in days) at which this step occurs — a death age. */
  readonly ageDays: number;
  /** Estimated probability `S(t)` of surviving to this age, 0..1. */
  readonly survival: number;
  /** Lines "at risk" just before this age (lifetime ≥ ageDays). */
  readonly atRisk: number;
  /** Deaths observed at exactly this age. */
  readonly deaths: number;
}

export interface SurvivalCurve {
  /** Step points, age-ascending, beginning at `{ ageDays: 0, survival: 1 }`. */
  readonly points: readonly SurvivalPoint[];
  /** Lines observed (births) — deaths + censored. */
  readonly totalLines: number;
  /** Lines observed to die. */
  readonly deaths: number;
  /** Lines still alive at the tip (right-censored). */
  readonly censored: number;
  /**
   * The greatest age (days) any line was observed for — the oldest line's age.
   * The curve has no support beyond this, so `S(t)` for larger `t` is
   * extrapolation, not observation (a young repo can't speak to 10-year survival).
   */
  readonly maxObservedAgeDays: number;
  /**
   * The **code half-life**: the smallest age (days) at which `S(t)` first falls
   * to ½ — the median line lifetime. Null when the curve never reaches ½ within
   * the observed history (a very stable, or very young, repository).
   */
  readonly halfLifeDays: number | null;
}

/**
 * Estimates the survival function `S(t)` of lines by the **Kaplan–Meier**
 * product-limit method. Ordering the distinct death ages `t₁ < t₂ < …`, with
 * `dᵢ` deaths at `tᵢ` and `nᵢ` lines still at risk (lifetime ≥ `tᵢ`, censored
 * survivors included):
 *
 * ```
 * S(tᵢ) = S(tᵢ₋₁) · (1 − dᵢ / nᵢ)
 * ```
 *
 * Censored lines (alive at the tip) leave the risk set at their censoring age
 * **without** counting as a death — which is exactly what stops recently-added
 * lines, that simply have not had the chance to die yet, from dragging the
 * curve down. Estimating survival from a snapshot of survivors alone would be
 * survivorship bias; the deaths are what make this honest.
 */
export function kaplanMeier(lifetimes: Iterable<LineLifetime>, now = Date.now()): SurvivalCurve {
  const observations: { age: number; death: boolean }[] = [];
  let deaths = 0;
  let censored = 0;
  let maxObservedAgeDays = 0;
  for (const line of lifetimes) {
    const end = line.diedAt ?? now;
    const age = Math.max(0, (end - line.bornAt) / DAY_MS);
    if (age > maxObservedAgeDays) maxObservedAgeDays = age;
    if (line.diedAt !== null) deaths++;
    else censored++;
    observations.push({ age, death: line.diedAt !== null });
  }

  const total = observations.length;
  const points: SurvivalPoint[] = [{ ageDays: 0, survival: 1, atRisk: total, deaths: 0 }];
  if (total === 0) {
    return {
      points,
      totalLines: 0,
      deaths: 0,
      censored: 0,
      maxObservedAgeDays: 0,
      halfLifeDays: null,
    };
  }

  observations.sort((a, b) => a.age - b.age);
  let survival = 1;
  let atRisk = total;
  let halfLifeDays: number | null = null;

  for (let i = 0; i < total; ) {
    const age = observations[i].age;
    let died = 0;
    let left = 0;
    while (i < total && observations[i].age === age) {
      if (observations[i].death) died++;
      else left++;
      i++;
    }
    if (died > 0) {
      survival *= 1 - died / atRisk;
      points.push({ ageDays: age, survival, atRisk, deaths: died });
      if (halfLifeDays === null && survival <= 0.5) halfLifeDays = age;
    }
    atRisk -= died + left; // both deaths and censored leave the risk set
  }

  return { points, totalLines: total, deaths, censored, maxObservedAgeDays, halfLifeDays };
}

/** Survival `S(t)` read off the step function at an arbitrary age (days). */
export function survivalAt(curve: SurvivalCurve, ageDays: number): number {
  let survival = 1;
  for (const point of curve.points) {
    if (point.ageDays > ageDays) break;
    survival = point.survival;
  }
  return survival;
}

// ──────────────────────────── Cohort stack plot ────────────────────────────

export interface CohortStack {
  /** Cohort keys, oldest → newest (e.g. `['≤2019', '2020', …]`). */
  readonly bands: readonly string[];
  /** Sample times (ms epoch), ascending — the x-axis. */
  readonly times: readonly number[];
  /** Per band, the number of its lines alive at each sample time. */
  readonly counts: ReadonlyMap<string, readonly number[]>;
}

/** Index of the first sample `≥ t`, or `times.length` when `t` is past the end. */
function firstAtOrAfter(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Builds the stacked time series of surviving lines per **birth-year cohort**:
 * for each sample time `t`, how many lines from each cohort are alive (born
 * `≤ t`, not yet dead at `t`). When the history spans more than `maxBands`
 * years, the oldest are folded into a single `≤YYYY` band so the legend stays
 * readable. Computed in one pass with per-band birth/death deltas, then a prefix
 * sum — not a blame at every sample.
 */
export function cohortSeries(
  lifetimes: Iterable<LineLifetime>,
  options: { now?: number; samples?: number; maxBands?: number } = {},
): CohortStack {
  const now = options.now ?? Date.now();
  const samples = Math.max(2, options.samples ?? 48);
  const maxBands = Math.max(1, options.maxBands ?? 8);
  const list = [...lifetimes];
  if (list.length === 0) return { bands: [], times: [], counts: new Map() };

  let minBorn = Infinity;
  for (const line of list) if (line.bornAt < minBorn) minBorn = line.bornAt;
  const start = minBorn;
  const end = Math.max(now, start + 1);
  const times: number[] = [];
  for (let i = 0; i < samples; i++) times.push(start + ((end - start) * i) / (samples - 1));

  const yearOf = (ms: number): number => new Date(ms).getUTCFullYear();
  const years = [...new Set(list.map((line) => yearOf(line.bornAt)))].sort((a, b) => a - b);
  // Keep the newest `maxBands - 1` years on their own; fold the rest into one band.
  const foldBelow = years.length > maxBands ? years[years.length - maxBands + 1] : -Infinity;
  const foldLabel = Number.isFinite(foldBelow) ? `≤${foldBelow - 1}` : null;
  const bandKey = (ms: number): string => {
    const year = yearOf(ms);
    return foldLabel && year < foldBelow ? foldLabel : String(year);
  };
  const bands = foldLabel
    ? [foldLabel, ...years.filter((y) => y >= foldBelow).map(String)]
    : years.map(String);

  const deltas = new Map<string, Float64Array>();
  for (const band of bands) deltas.set(band, new Float64Array(samples));
  for (const line of list) {
    const delta = deltas.get(bandKey(line.bornAt))!;
    const bornIdx = firstAtOrAfter(times, line.bornAt);
    if (bornIdx < samples) delta[bornIdx] += 1;
    if (line.diedAt !== null) {
      const dieIdx = firstAtOrAfter(times, line.diedAt);
      if (dieIdx < samples) delta[dieIdx] -= 1;
    }
  }

  const counts = new Map<string, number[]>();
  for (const band of bands) {
    const delta = deltas.get(band)!;
    const series = new Array<number>(samples);
    let running = 0;
    for (let i = 0; i < samples; i++) {
      running += delta[i];
      series[i] = running;
    }
    counts.set(band, series);
  }
  return { bands, times, counts };
}

// ───────────────────────────── Authorship share ─────────────────────────────

/** One author's stake in the code alive today. */
export interface AuthorCohort {
  readonly author: string;
  /** Surviving (alive) lines attributed to this author. */
  readonly lines: number;
  /** Fraction of the surviving lines, 0..1. */
  readonly share: number;
}

/**
 * Share of the code **alive at the tip** by author — the "% of code by author"
 * breakdown. Authors are ranked most-lines first; beyond `limit`, the tail is
 * folded into a single "Others" entry so the legend stays bounded.
 */
export function authorShares(
  lifetimes: Iterable<LineLifetime>,
  options: { limit?: number } = {},
): AuthorCohort[] {
  const byAuthor = new Map<string, number>();
  let total = 0;
  for (const line of lifetimes) {
    if (line.diedAt !== null) continue; // only code that is still present
    total++;
    byAuthor.set(line.author, (byAuthor.get(line.author) ?? 0) + 1);
  }

  const ranked = [...byAuthor.entries()]
    .map(([author, lines]) => ({ author, lines, share: total ? lines / total : 0 }))
    .sort((a, b) => b.lines - a.lines || a.author.localeCompare(b.author));

  const limit = options.limit;
  if (!limit || ranked.length <= limit) return ranked;
  const head = ranked.slice(0, limit - 1);
  const tailLines = ranked.slice(limit - 1).reduce((sum, a) => sum + a.lines, 0);
  head.push({ author: 'Others', lines: tailLines, share: total ? tailLines / total : 0 });
  return head;
}

// ──────────────────────────────── Benchmark ────────────────────────────────

/**
 * Reference points from Erik Bernhardsson's "The half-life of code" (2016): a
 * code half-life of roughly **6 years**, with about **40% of lines still
 * present even after 10 years**. Plotted as a dashed reference so a repository's
 * own survival curve can be read against "the half-life of code".
 */
export const CODE_HALF_LIFE_BENCHMARK = {
  halfLifeYears: 6,
  survivalAtTenYears: 0.4,
  /** Age (years) → surviving fraction anchors for the reference line. */
  points: [
    { years: 0, survival: 1 },
    { years: 6, survival: 0.5 },
    { years: 10, survival: 0.4 },
  ],
} as const;

// ─────────────────────────────── Roll-up ───────────────────────────────

/** Everything the Insights "Age" tab renders, from one lifetime table. */
export interface SurvivalReport {
  readonly curve: SurvivalCurve;
  readonly cohorts: CohortStack;
  readonly authors: readonly AuthorCohort[];
  /** Lines alive at the tip (the size of "the code"). */
  readonly aliveLines: number;
  /** All lines ever observed across the walked history (alive + dead). */
  readonly trackedLines: number;
}

/** Runs the three analyses over one lifetime table — the store's publish payload. */
export function summarizeSurvival(
  lifetimes: Iterable<LineLifetime>,
  options: { now?: number; samples?: number; maxBands?: number; authorLimit?: number } = {},
): SurvivalReport {
  const list = [...lifetimes];
  const now = options.now ?? Date.now();
  let alive = 0;
  for (const line of list) if (line.diedAt === null) alive++;
  return {
    curve: kaplanMeier(list, now),
    cohorts: cohortSeries(list, { now, samples: options.samples, maxBands: options.maxBands }),
    authors: authorShares(list, { limit: options.authorLimit ?? 8 }),
    aliveLines: alive,
    trackedLines: list.length,
  };
}
