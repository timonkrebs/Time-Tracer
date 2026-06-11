import { BlameOwner, BlameState } from '../../core/store/repo-store';
import { relativeTime, shortDate, shortSha } from '../../core/util/relative-time';

/** Annotation text colour by commit age — oldest first, newest last. */
const AGE_CLASSES = [
  'text-zinc-600',
  'text-zinc-500',
  'text-zinc-400',
  'text-indigo-300/90',
  'text-amber-300/90',
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

  // Rank unique commit times so annotation colour reflects relative age.
  const uniqueTimes = [
    ...new Set(
      owners
        .filter((o): o is Exclude<BlameOwner, 'older' | null> => !!o && o !== 'older')
        .map((o) => Date.parse(o.commit.authoredAt) || 0),
    ),
  ].sort((a, b) => a - b);
  const colorFor = (time: number): string => {
    if (uniqueTimes.length <= 1) return AGE_CLASSES[AGE_CLASSES.length - 1];
    const rank = uniqueTimes.indexOf(time) / (uniqueTimes.length - 1);
    return AGE_CLASSES[Math.round(rank * (AGE_CLASSES.length - 1))];
  };

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
    return {
      sha: commit.sha,
      lineAtCommit: owner.line,
      label: `${shortDate(commit.authoredAt)} ${commit.authorName}`,
      title: `${commit.summary}\n${shortSha(commit.sha)} · ${commit.authorName} · ${shortDate(commit.authoredAt)} (${relativeTime(commit.authoredAt)})`,
      labelClass: blockStart
        ? colorFor(Date.parse(commit.authoredAt) || 0)
        : `${colorFor(Date.parse(commit.authoredAt) || 0)} opacity-60`,
      pending: false,
    };
  });
}
