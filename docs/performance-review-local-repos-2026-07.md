# Performance Review — Local Repositories (July 2026)

A focused follow-up to the [July 2026 architecture review](architecture-review-2026-07.md),
triggered by a concrete complaint: **opening a file's history on a local repository is very
slow.** This review traces every read a local-repo action performs — through
`LocalGitProvider`, the `fsa-fs` File System Access adapter and into isomorphic-git's
internals — explains where the time actually goes, and lands fixes for the systemic causes.
Line anchors refer to this review's base commit.

## Executive summary

The July review already put isomorphic-git's `cache` object on every call and added the
one-pass `primeHistories` walk for the folder-ownership scan. Both help, but the profile
shows the remaining costs sit one layer deeper, in three places:

1. **The History panel never used the fast walk.** A History click called
   `listCommits({ path })`, which went to isomorphic-git's `log({ filepath })` — a
   _full-history_ walk that re-resolves the file's path from the root tree **for every
   commit visited**, repeated **per file** you look at. The provider's own prime walk
   answers the same question for _every_ path at once, at about the cost the library
   charges for one file — but it was only wired to the ownership scan.
2. **isomorphic-git has no oid-level object cache, and its storage layer taxes every
   read.** The `cache` parameter memoises only the parsed pack _index_ (`PackfileCache`)
   and the working-tree index. Every single object read — every commit, tree and blob, on
   every walk — first probes the loose-object path (a failed File System Access round trip
   - exception on packed repos) and then calls `fs.readdir('.git/objects/pack')` _again_
     (another FSA round trip). Loose objects are re-fetched and re-inflated on **every**
     access — brutal for the most common local case, an active working repo with thousands
     of loose objects.
3. **Unfiltered history paging was quadratic.** `log` cannot resume; it re-walks from the
   tip on every call. The Age and co-change walks page the whole history 100 commits at a
   time, so reading n commits cost O(n²/100) commit visits.

All three are fixed in this change, plus two smaller `getTree` costs (per-call re-`stat`
of every working-tree file; strictly serial subtree walks). Measured on an in-memory fs —
i.e. with **zero** FSA round-trip cost, so the real-world gap is larger — ten file
histories on a 300-commit, 50-file repo went from **1360 ms to 204 ms (6.7×)**, and the
new cost is one-time: every further file history (and the history read of the Age walk)
is a cache slice.

## Where the time went

### 1. File history: `log({ filepath })` is the wrong primitive — High, fixed

`loadHistory(path)` (`repo-store.ts:1168`) calls `listCommits({ ref, path, perPage: 30 })`;
the local provider forwarded a path filter to `git.log({ filepath, force: true })`
(`local-provider.ts:361`, before this change). Inside isomorphic-git (`_log`):

- The walk visits **every reachable commit** — a path filter has no shallow form.
- For each visited commit it calls `resolveFilepath` from the commit's **root tree**, so a
  file at depth d costs d nested tree reads _per commit_.
- Parents are deduped only against the current `tips` array, not a visited set, and
  `tips` is re-sorted per commit — merge-heavy histories with skewed timestamps can
  re-expand whole subgraphs.
- Nothing of this is memoised across calls: the next file's History click starts the
  whole walk again.

So one History click cost ~`commits × (1 + path depth)` object reads, each paying the
per-read storage tax below — and _N_ clicks cost _N_ of these walks. The provider already
had the right primitive: `primeHistories` walks the log once and diffs each commit
against its first parent with oid-pruned tree comparison (identical subtrees skipped,
`local-provider.ts` `diffTrees`), producing **every** path's history in
~O(commits + changes).

**Fix:** `commitLog` now routes any path-filtered request through the prime walk and
serves it (and all subsequent paths, and all pages) from the log cache. The walk is
started at most once per fs+ref — concurrent requests (a History click racing the
ownership scan or blame prefetch) share one in-flight promise — and a warm walk yields a
macrotask every 1024 commits so it cannot starve rendering. Since the walk visits every
commit anyway, it also seeds the **unfiltered** log cache as complete, which makes the
Age/co-change "Reading history…" phase a cache slice after any file-history click (and
vice versa).

Semantics note: primed histories diff each commit against its parents, with
`git log -- <path>` parent simplification at merges — a merge enters a path's history
only when the path differs from **every** parent, so a change arriving unmodified from a
side branch stays attributed to that branch's own commits. Previously the panel's content
depended on _which feature ran first_ (unprimed filepath-log vs primed first-parent
diffs); now it is consistent and matches git's behavior. For linear histories (the
overwhelming case) the result is identical to the old filepath log.

### 2. The storage layer taxed every object read — High, fixed

isomorphic-git's `_readObject` does, on **every** call:

```
readObjectLoose()          → fs.readFile('.git/objects/aa/bb…')   // fails on packed repos:
                                                                  // 1 FSA round trip + exception
readObjectPacked()         → fs.readdir('.git/objects/pack')      // EVERY read: 1 FSA dir iteration
                           → pack index lookup (cached), inflate
```

and there is **no oid-level cache**: a loose object is re-fetched over FSA and
re-inflated every time it is read. Blame, trace, diffs and the survival walk read the
same commits and trees over and over; on an active local repo most of those are loose.

**Fix (`fsa-fs.ts`):** `.git/objects/` is content-addressed and the repo is read-only for
the session (the invariant the provider's log/tree caches already rely on), so the
adapter now caches exactly what the library re-asks for:

- **Listings** of object-store directories (`objects/pack` is re-listed per packed read).
- **Negative lookups** under `.git/objects/` — the loose probe that precedes every packed
  read short-circuits in memory. Only genuine `NotFoundError`s are cached; a
  `TypeMismatchError` (directory probed as file, e.g. by `stat`) or a permission error
  never poisons the cache.
- **Loose object bytes**, LRU with a 64 MB budget and a 1 MB per-file cap (packfiles and
  `.idx` files stay out — isomorphic-git caches those itself; callers never mutate read
  buffers, so instances are shared).

Net effect: on packed repos the two wasted FSA round trips per object read disappear; on
loose-heavy repos repeated reads become memory hits. This multiplies with every feature —
history, blame, trace, diffs, rename search, the Age walk.

### 3. Quadratic unfiltered paging — High, fixed

`commitLog` grew its cached prefix by exactly one page per call, but `log` re-walks from
the tip each time: paging n commits at `WALK_PAGE_SIZE = 100` (`repo-store.ts:1904`)
visited `100 + 200 + … + n ≈ n²/200` commits. **Fix:** each extension now at least
doubles the requested depth, so paging the whole history visits ≤ 2n commits across
O(log n) walks — and after any prime walk the unfiltered log is already complete, so the
Age walk's read phase does no walking at all.

### 4. `getTree` re-paid its costs on every call — Medium, fixed

- `withSizes` stat'ed **every** working-tree file (two FSA round trips each, 48-way
  concurrent) on every tree load — repo open, every branch switch, and every per-sha
  `treeAt` of the rename/origin searches. Sizes now memoise per fs (`path → size|absent`),
  so only never-seen paths pay a round trip.
- `walkTree` awaited each subtree strictly serially, making a cold tree load latency-bound
  (Σ tree-read RTT). Sibling subtrees now load concurrently — capped by a small semaphore
  (24 in-flight tree reads) so wide monorepos don't flood the FSA queue — with
  deterministic assembly, and tree reads go through the provider's shared `treeCache`, so
  the tree walk, the prime walk, `getCommitFiles` and the rename search all reuse each
  other's parsed trees.

## Measured

In-memory fs (mem-fs — so _without_ any FSA round-trip savings; real folders gain more),
301 commits, 50 files at depth 3, opening the history of 10 files:

|                              | before                               | after                                    |
| ---------------------------- | ------------------------------------ | ---------------------------------------- |
| 10 × `listCommits({ path })` | 1360 ms (136 ms _per file_, forever) | 204 ms **one-time**, then ~0 ms per file |

The full suite (867 tests, 12 new) and a production build pass. New regression specs pin:
prime-walk routing (no `filepath` log, one walk for concurrent requests, unfiltered-log
seeding), geometric depth growth, and every fsa-fs cache including the
directory-probed-as-file poisoning edge case.

## Known remaining costs (library-level, not fixed here)

- **First touch of each packfile hashes the whole pack.** isomorphic-git verifies pack
  integrity with a full SHA-1 over the payload in JS on first read — seconds for a
  multi-hundred-MB pack, once per session. Upstream behavior; not bypassable through the
  public API.
- **Packfiles are read fully into memory** (`fs.read(packFile)`) and kept for the session
  in `PackfileCache`. Unavoidable with isomorphic-git's storage design; the WeakMap-per-fs
  cache means it dies when the folder is re-picked.
- **`_log` has no visited set** — merge-heavy histories with non-monotonic commit
  timestamps can re-visit subgraphs. We no longer use the worst shape (`filepath` logs),
  but the initial full log of a prime walk still runs through it.
- **`GitPackIndex.offsetCache` is unbounded** — it retains inflated bytes for every packed
  object ever read (again per-fs, dying with the folder).

## Still open in our own code (unchanged priorities from the July review)

- History panel renders an unvirtualized commit list after "Load all"
  (`file-history.ts`) — for a 10k-commit file the _rendering_ now dominates the loading.
- Copy-on-write Map signals (`cacheCommits` et al.) make very long walks quadratic in
  store writes (`repo-store.ts:2829+`).
- `historyCache`/`_files`/`treeCache` in the store remain unbounded until the next repo
  load; the new provider-side caches are bounded (loose bytes) or die with the fs
  (WeakMaps).
- No `AbortController` cancellation; a navigation away lets walks finish pointlessly.

## Invariants these changes rely on

A locally opened folder is treated as **frozen for the session** — the same assumption
the existing log/tree/prime caches already made. Running `git commit`/`gc`/`fetch` in the
folder while it is open in Time Tracer serves stale (but internally consistent) data
until the folder is re-picked or reconnected, which creates a fresh `FsLike` and thereby
fresh caches. Within `.git/objects` this is additionally backed by git's own guarantee:
object files are content-addressed and immutable.
