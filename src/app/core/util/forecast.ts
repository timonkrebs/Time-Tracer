/**
 * Tech-debt forecast — files whose churn is *accelerating*, flagged as likely
 * next hotspots. Where {@link ./hotspots} answers "what's hot now", this answers
 * "what's heating up": split the analysed history in half and compare how often
 * each file changed recently versus before. Files changing more now than they
 * used to are the rising risks — a rough weather forecast for where the next
 * bugs may land. Pure and deterministic.
 */

/** A commit reduced to its moment and the files it changed. */
export interface ForecastCommit {
  /** ISO 8601 author date. */
  readonly authoredAt: string;
  readonly files: readonly string[];
}

/** One file's recent-versus-prior churn. */
export interface ForecastFile {
  readonly path: string;
  /** Commits touching the file in the recent half of the window. */
  readonly recent: number;
  /** Commits touching it in the older half. */
  readonly prior: number;
  /** `recent − prior`: how much its change rate has risen. */
  readonly acceleration: number;
}

export interface Forecast {
  /** Rising files (positive acceleration, enough recent activity), hottest first. */
  readonly files: readonly ForecastFile[];
  /** Epoch (ms) dividing the prior and recent halves. */
  readonly splitAt: number;
  /** Oldest and newest commit times observed (ms epoch). */
  readonly from: number;
  readonly to: number;
}

const DEFAULT_MIN_RECENT = 2;
/** Commits touching more than this many files are churn noise (sweeps, merges). */
const DEFAULT_MAX_COMMIT_FILES = 25;

const EMPTY: Forecast = { files: [], splitAt: 0, from: 0, to: 0 };

/**
 * Ranks files by churn acceleration across a window of commits. The window
 * [oldest…newest] is split at its midpoint; a file's `acceleration` is its
 * recent-half change count minus its older-half count. Only files with at least
 * `minRecent` recent commits and positive acceleration are returned (the rising
 * ones), hottest first. Over-large commits are dropped as noise, like hotspots.
 */
export function computeForecast(
  commits: Iterable<ForecastCommit>,
  options: { minRecent?: number; maxCommitFiles?: number } = {},
): Forecast {
  const minRecent = options.minRecent ?? DEFAULT_MIN_RECENT;
  const maxCommitFiles = options.maxCommitFiles ?? DEFAULT_MAX_COMMIT_FILES;

  const times = new Map<string, number[]>();
  let from = Infinity;
  let to = -Infinity;
  for (const commit of commits) {
    const time = Date.parse(commit.authoredAt);
    if (Number.isNaN(time)) continue;
    const files = [...new Set(commit.files)];
    if (files.length === 0 || files.length > maxCommitFiles) continue;
    if (time < from) from = time;
    if (time > to) to = time;
    for (const file of files) {
      let arr = times.get(file);
      if (!arr) times.set(file, (arr = []));
      arr.push(time);
    }
  }
  if (!Number.isFinite(from)) return EMPTY;

  const splitAt = to - (to - from) / 2;
  const files: ForecastFile[] = [];
  for (const [path, stamps] of times) {
    let recent = 0;
    let prior = 0;
    for (const time of stamps) time >= splitAt ? recent++ : prior++;
    const acceleration = recent - prior;
    if (recent >= minRecent && acceleration > 0) {
      files.push({ path, recent, prior, acceleration });
    }
  }
  files.sort(
    (a, b) =>
      b.acceleration - a.acceleration || b.recent - a.recent || a.path.localeCompare(b.path),
  );
  return { files, splitAt, from, to };
}
