import { BlameOwner, BlameState } from '../../core/store/repo-store';
import { relativeTime, shortDate, shortSha } from '../../core/util/relative-time';

/** Annotation text colour by commit age: muted old history -> fresher green. */
const AGE_CLASSES = [
  'text-zinc-600',
  'text-slate-500',
  'text-sky-400/90',
  'text-teal-300/90',
  'text-emerald-300/90',
];

/** One rendered blame gutter cell. */
export interface AnnotationCell {
  readonly sha: string | null;
  /** Position of the line in the file as of the introducing commit. */
  readonly lineAtCommit: number;
  /** `dd.mm.yyyy author`, shown on every line (IDE style); '' while pending. */
  readonly label: string;
  readonly title: string;
  /** Colour by age; continuation lines of a block render slightly dimmed. */
  readonly labelClass: string;
  /** True while the attribution is still being computed. */
  readonly pending: boolean;
}

const EMPTY_CELL: AnnotationCell = {
  sha: null,
  lineAtCommit: 0,
  label: '',
  title: '',
  labelClass: '',
  pending: false,
};

/**
 * Turns a blame state into per-line gutter cells (`count` of them): every
 * line shows `date author` for the commit that introduced it, age-coloured,
 * with continuation lines of a same-commit block slightly dimmed. Lines
 * without an owner render as pending while the blame is computing.
 */
export function buildAnnotationCells(
  blame: BlameState | null,
  count: number,
): readonly AnnotationCell[] {
  const owners: readonly BlameOwner[] =
    blame && (blame.status === 'computing' || blame.status === 'ready') ? blame.lines : [];
  const computing = blame?.status === 'computing';

  // Rank unique commit times so annotation colour reflects relative age, then
  // resolve every time to its colour up front. A per-line `indexOf` would make
  // building the cells O(lines × commits); a precomputed map keeps it linear.
  const uniqueTimes = [
    ...new Set(
      owners
        .filter((o): o is Exclude<BlameOwner, 'older' | null> => !!o && o !== 'older')
        .map((o) => Date.parse(o.commit.authoredAt) || 0),
    ),
  ].sort((a, b) => a - b);
  const newest = AGE_CLASSES[AGE_CLASSES.length - 1];
  const colorByTime = new Map<number, string>();
  if (uniqueTimes.length > 1) {
    const span = uniqueTimes.length - 1;
    uniqueTimes.forEach((time, rank) => {
      colorByTime.set(time, AGE_CLASSES[Math.round((rank / span) * (AGE_CLASSES.length - 1))]);
    });
  }
  const colorFor = (time: number): string => colorByTime.get(time) ?? newest;

  return Array.from({ length: count }, (_, index) => {
    const owner = owners[index] ?? null;
    const previous = index > 0 ? (owners[index - 1] ?? null) : undefined;
    const blockStart = !(
      owner !== null &&
      previous !== undefined &&
      previous !== null &&
      (owner === 'older'
        ? previous === 'older'
        : previous !== 'older' && owner.commit.sha === previous.commit.sha)
    );

    if (owner === null) {
      return computing ? { ...EMPTY_CELL, pending: true } : EMPTY_CELL;
    }
    if (owner === 'older') {
      return {
        ...EMPTY_CELL,
        label: '· · ·',
        title: 'Older than the loaded history pages — load more commits in the History panel.',
        labelClass: blockStart ? 'text-zinc-700' : 'text-zinc-700 opacity-60',
      };
    }
    const commit = owner.commit;
    const message = commit.message.trim() || commit.summary;
    const color = colorFor(Date.parse(commit.authoredAt) || 0);
    return {
      sha: commit.sha,
      lineAtCommit: owner.line,
      label: `${shortDate(commit.authoredAt)} ${commit.authorName}`,
      title: `${message}\n\n${shortSha(commit.sha)} · ${commit.authorName} · ${shortDate(commit.authoredAt)} (${relativeTime(commit.authoredAt)})`,
      labelClass: blockStart ? color : `${color} opacity-60`,
      pending: false,
    };
  });
}
