import { BlameOwner, BlameState } from '../../core/store/repo-store';
import { relativeTime, shortSha } from '../../core/util/relative-time';

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
  readonly label: string;
  readonly title: string;
  readonly colorClass: string;
  /** False when the previous line shares the owner (block grouping). */
  readonly showLabel: boolean;
  /** True while the attribution is still being computed. */
  readonly pending: boolean;
}

const EMPTY_CELL: AnnotationCell = {
  sha: null,
  lineAtCommit: 0,
  label: '',
  title: '',
  colorClass: '',
  showLabel: false,
  pending: false,
};

/**
 * Turns a blame state into per-line gutter cells (`count` of them), with
 * age-ranked colours and IntelliJ-style block grouping. Lines without an
 * owner render as pending while the blame is computing.
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
    const sameAsPrevious =
      owner !== null &&
      previous !== undefined &&
      previous !== null &&
      (owner === 'older'
        ? previous === 'older'
        : previous !== 'older' && owner.commit.sha === previous.commit.sha);

    if (owner === null) {
      return computing ? { ...EMPTY_CELL, pending: true } : EMPTY_CELL;
    }
    if (owner === 'older') {
      return {
        ...EMPTY_CELL,
        label: '· · ·',
        title: 'Older than the loaded history pages — load more commits in the History panel.',
        showLabel: !sameAsPrevious,
      };
    }
    const commit = owner.commit;
    return {
      sha: commit.sha,
      lineAtCommit: owner.line,
      label: `${commit.authorName} · ${relativeTime(commit.authoredAt)}`,
      title: `${commit.summary}\n${shortSha(commit.sha)} · ${commit.authorName} · ${relativeTime(commit.authoredAt)}`,
      colorClass: colorFor(Date.parse(commit.authoredAt) || 0),
      showLabel: !sameAsPrevious,
      pending: false,
    };
  });
}
