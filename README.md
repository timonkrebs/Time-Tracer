# Time Tracer

**Try it live: [gittimetracer.netlify.app](https://gittimetracer.netlify.app/)**

Explore any public GitHub, GitLab, Bitbucket or Azure DevOps repository — a self-hosted GitHub
Enterprise / GitLab / Bitbucket Server instance, or a git repository from your own disk — and
travel back through its history change by change. Installable as an offline-capable PWA.

Time Tracer is a **client-only** Angular app: there is no backend. Hosted repositories are read
through the GitHub/GitLab/Bitbucket/Azure DevOps REST APIs; local folders are read directly via the
File System Access API and parsed with isomorphic-git. Nothing you browse ever leaves your machine.

## Vision

The end goal is an interactive **git blame explorer** in the spirit of IntelliJ's annotate view:

- Annotate a file and step **backwards in time hunk by hunk** — select a hunk, jump to the state
  of the file _before_ the commit that introduced it, and keep digging recursively.
- **Don't stop at renames.** Where `git blame` normally ends at a rename or content move, Time
  Tracer will present a ranked list of **candidate predecessor files** so the journey back in time
  can continue across renames and code moves.

Both halves of that vision are now in place: hunk-level time travel (◂ Before, blame chains and
the per-hunk _Trace_ history filter) and rename candidates that continue the journey across
renames — see the feature list and roadmap below for what's done and what's next.

## Current features

- **Load a repo** from `owner/repo`, any `github.com` URL (`/tree/<ref>`, `/blob/<ref>/<path>`,
  commit URLs, `.git`, SSH form), a `raw.githubusercontent.com` URL — including branch names
  containing `/`, resolved against the repo's real refs — or any `gitlab.com` URL
  (`…/gitlab-org/gitlab.git`, `/-/tree/...`, `/-/blob/...`, nested groups included), any
  `bitbucket.org` URL (`/{workspace}/{repo}`, `/src/<ref>/<path>`, `/commits/<sha>`, SSH), or any
  Azure DevOps URL (`dev.azure.com/{org}/{project}/_git/{repo}`, pull-request/commit pages,
  `?path=…&version=GB…` state, `{org}.visualstudio.com`, SSH) — anonymous AZD access works for
  public projects; private ones explain that sign-in is required.
- **Self-hosted & enterprise instances**: a start-page form connects to a **GitHub Enterprise
  Server**, **self-hosted GitLab**, or **Bitbucket Server / Data Center** instance by its base URL
  (paste a full URL on the instance or just `owner/repo`). The same GitHub/GitLab readers target
  the instance's `/api/v3` / `/api/v4` endpoints; Bitbucket Server uses its REST 1.0 API. The host
  travels in a `host` query param, so self-hosted deep links are shareable too, and each instance
  keeps its own access token.
- **Open local repositories** like vscode.dev: pick a folder with the File System Access API and
  Time Tracer parses its `.git` directly in the browser with isomorphic-git — full tree, history,
  diffs, blame and rename candidates, completely offline and read-only. Folder handles persist
  across reloads (IndexedDB); a one-click "Reconnect folder" re-grants permission. Local
  repositories also unlock the **Age** tab (code survival & cohorts), which walks the whole history.
- **Desktop-first split-pane viewer**: resizable file tree (drag the divider, double-click to
  reset, or collapse it entirely with the header toggle — remembered while you browse, and
  re-revealed whenever you open another repository) next to a file view with a line-number
  gutter that carries the blame annotations.
- **Quick file finder**: `Ctrl/⌘ P` (or the header's search button) opens a command-palette
  overlay to fuzzy-find any file by path — filename hits rank first, with boundary- and
  run-aware scoring and the matched characters highlighted; arrow keys move, Enter opens, Escape
  dismisses. It searches the tree already in memory, so it costs no extra API requests.
- **Keyboard shortcuts**: drive the viewer without the mouse — `←`/`→` step to the older/newer
  commit, `b` toggles blame, `h` history, `o` owners, `t` the file tree, `Ctrl/⌘ P` opens the
  finder, and `Esc` closes the side panels. Shortcuts stand down while a field is focused or the
  finder is open, and the relevant buttons show their key in the tooltip.
- **Per-file commit history**: a History panel lists the commits that touched the selected file
  (paginated — page through older commits or **Load all** at once), with author and relative date.
  Its open/closed state is remembered, so it can stay open permanently across files and sessions.
- **Code ownership ("Owners" panel)**: folds the per-line blame into an authorship summary for the
  selected file — share by author, bus factor and who last touched it ("who do I ask about
  this?") — for free from the blame already computed. An opt-in folder scan blames the files under
  the folder (subfolders included) — largest first and capped, with the scanned files listed on
  hover and a one-click option to load them all — and aggregates them, streaming as each is added.
  Whenever the blame the chart needs is **already in cache** — the folder's files were browsed, or a
  scan ran earlier — the "Folder · …" chart shows straight away with no "Scan this folder" click, for
  hosted repositories too (it costs no requests, it is just data already on hand). For **local
  repositories** the whole history is on disk, so the scan is free and runs automatically.
- **Insights — a metrics view** (the chart toggle in the header), from one walk of recent
  commits — capped by default, or **"Load all commits"** to walk the whole history — in the spirit
  of Tornhill's _Your Code as a Crime Scene_. **Hotspots**, **Coupling**, **Team**, **Knowledge**
  and **Age** are always a tab-switch apart:
  - **Hotspots** — files ranked by **recency-weighted churn** (`core/util/hotspots.ts`), shown as
    a **treemap** (rectangle = size/LOC, colour = heat) _and_ a ranked list; click a file to open
    it.
  - **Change coupling** — the **files that change together** ("touch `auth.ts`, you usually touch
    `session.ts`"), shown as the **top ~10 most-coupled clusters** drawn as node-link graphs with
    the **coupling strength on every edge** (connected components of the strong couplings, sized
    to an adjustable **min–max range slider** — tame "everything-touches-everything" hairballs
    from the top, drop noisy small clusters from the bottom) plus the full pair list. **Filter to
    one file** — pick it in the tree or click any file (cluster node or pair) — to walk its _full_
    history and see only the connections to and from it; **Clear filter** drops it again while the
    repo-wide overview stays put. Flip the granularity to **Modules** to roll the same coupling up
    to **folders** (`computeModuleCoChange`), drawn as the same weighted graphs: which parts of
    the tree change together. The folder depth is **picked automatically** (deep enough that no
    single folder like `src/app` swallows the tree), root-level files (manifests, lockfiles) are
    ignored as config noise, and every folder pair is grounded by the **file pairs driving it**
    ("via `repo-store.ts ↔ insights-view.ts`"). Cross-boundary coupling (`auth/ ↔ ui/`) is the
    architectural-decay smell; within-folder churn is expected and collapses away. The same data
    powers an **"Often changes with"** list on the open file in the History panel.
  - **Team collaboration** — a **developer social graph** (`core/util/team-graph.ts`): the
    people-shaped twin of change coupling. Two developers are tied when they **edit the same
    files**, the tie's strength being their file-set Jaccard overlap, drawn as a **force-directed
    node-link graph** (`core/util/force-layout.ts` — collaborators attract, everyone repels, so
    teams clump and bridges sit between; disc = commits, colour = the connected "team") over the
    same commit walk. Developers are keyed by email identity (name for display). A **Timing
    slider** blends each tie from its **all-time** file overlap toward a **temporal** strength that
    weights every shared file by the two developers' best **handoff** on it — how close together
    their edits were (~30-day half-life) _and_ how recently it happened relative to the newest commit
    (~90-day age half-life) — so dragging from _all-time_ to _recent_ re-shapes the force layout
    live, morphing the graph from "ever shared a file" toward "currently working together" (and
    fading old, far-apart ties to nothing). **Click a developer** to light up their collaborators and
    read them ranked by shared files; a **"Most connected"** list surfaces the people who bridge the
    work and a **"Working in isolation"** list
    the silos — developers whose files nobody else touches (left out of the graph, since they have
    nothing to connect to). Reveals cross-team collaboration and silos from git alone, no review API
    required.
  - **Knowledge loss / turnover risk** (`core/util/knowledge.ts`) — files ranked by how much of
    their **authored knowledge** has left the project. Each file's recent authorship is folded into
    a recency-weighted share per contributor, weighted by how long each has since gone quiet, and
    shown as a **risk treemap** (rectangle = size, colour = orphaned share) _and_ a ranked list that
    names every file's primary expert and when they were last active. "Gone" is inferred only from
    commit silence (never asserted) and automated/bot authors are filtered out, so a capped walk is
    marked partial — **Load all commits** for a complete turnover picture.
  - **Age — code survival & cohorts** (`core/util/survival.ts`), in the spirit of Bernhardsson's
    _Git of Theseus_, **for local repositories** (it walks the whole history, so it's offered only
    where that's free of network requests). A full-history forward walk tags every line with the
    commit that introduced it and records when it is later removed, then plots a **cohort stack** of
    surviving lines by year added, the **% of the code alive today by author**, and a **Kaplan–Meier
    survival curve** — the probability a line is still present _t_ years on — annotated with the
    repo's **code half-life** and Bernhardsson's "half-life of code" benchmark (≈6-year half-life,
    ≈40% of lines alive after 10 years). Survivors are censored at the tip commit's time, in-file
    moves keep a line's age, and the walk follows the first-parent mainline; it streams as it goes.

  Mega-commits are filtered out as churn noise, and **generated/vendored files** (lockfiles,
  `dist/`/`build/` output, minified assets and the like — gitignore-style patterns in
  `core/util/ignore.ts`) are held out of all three metrics so they don't drown the signal; the
  count of hidden files is shown in the header. The walk streams as it goes.

- **Time travel**: pick any commit to see the file exactly as it was, with a banner showing where
  in time you are and a one-click way back to the tip. The ← Older / Newer → steppers are always
  visible (only the dead direction is disabled) and work straight from the current version,
  auto-loading more history when you walk past the loaded pages. Like `git log -- <path>`,
  history currently stops at renames — continuing past them is a later milestone.
- **Changes view (default)**: picking a commit opens what that commit changed in the file — a
  unified diff against its first parent, computed client-side with a minimal Myers diff (dual
  line-number gutter, hunk headers, +added/−removed stats, root/merge commits handled). Switch to
  _File_ to read the full version instead; your last File/Changes choice is remembered.
- **Blame annotations everywhere**: the _Blame_ toggle is available in both views. In the file
  view it annotates every line with the commit that introduced it (`dd.mm.yyyy author` on every line, IDE-style, colour-coded
  older→newer, IntelliJ-style block grouping); very large blamed files are **row-virtualized**, so
  only the lines in view are in the DOM and a 10k-line file scrolls smoothly. In the changes view it switches to a **split
  view** — the version _before_ the commit on the left, _after_ on the right, removes/adds
  aligned side by side, and **both sides carry their own blame gutters**. Attribution is computed
  client-side by walking the file's history with the minimal diff, streams in progressively, and
  works at any historical version. Lines older than the loaded history pages are marked and
  re-attributed as soon as more commits are loaded (the History panel's "Load older commits" or
  "Load all").
- **Recursive time travel, hunk by hunk**: clicking a blame annotation opens the introducing
  commit's diff _scrolled to that exact line_; every hunk in a diff offers **◂ Before** — jump to
  the parent version, annotated, at the hunk's old position. Blame → commit → before → blame
  chains indefinitely, each step deep-linked (`line=` highlights and scrolls).
- **Per-hunk history filter ("Trace")**: every hunk offers **Trace**, and the file view's blame
  gutter line numbers are selectable as well (click, then shift-/click to extend) — so you can
  trace any range **straight from the current version**, not only from a commit's changes. The
  History panel narrows to only the commits that ever changed those lines, `git log -L` in the
  browser. The hunk's line range is followed backwards through every version with the same minimal diff
  blame uses (client-side, so it works for all providers): edits above shift the range and each edge
  follows its own line one step at a time through a rewrite, so the selection keeps its size instead of
  ballooning over a rewritten block — a single line stays a single line — and the walk stops
  at the commit that introduced the lines. The traced range lives in the URL (`line=18` or
  `line=18-19`), so it is shareable and survives reloads and view switches.
  Matches stream in as they are found, the walk pauses at the end of the
  loaded history pages ("Search older commits" continues it), and a banner shows the traced
  range with a one-click way back to the full history. Clicking a filtered commit time-travels
  as usual — stepping through exactly the commits that shaped those lines. Where the trace ends,
  **"Where did these lines come from?"** hunts for the block's origin: the introducing commit's
  other files (deleted ones are prime suspects) — or, on demand, the whole snapshot just before
  it — are searched with a line-level local alignment (exact lines anchor, edited lines score by
  per-line Levenshtein), and each ranked hit either jumps straight to the matching file and line in
  the predecessor's own timeline or, via **Diff**, lines the introduced block up against that source
  side by side (their shared lines fall to context, the rest reads as +/−).
- **Rename candidates**: where a file's recorded history ends, the History panel can search the
  commit just before it for likely predecessors — GitHub's own rename detection, files the
  creating commit _deleted_ (prime rename suspects, content-compared one by one), identical blobs
  in the parent tree, and name/size/content heuristics, each ranked with a confidence score.
  Content comparisons use a line-structured fuzzy similarity (exact lines via the minimal diff,
  edited lines via per-line Levenshtein), so a rename that also touched up lines still scores
  high. Picking a candidate continues the journey in the predecessor's own timeline (anchored at
  its last change before the rename), with history, blame and steppers all working there — or hit
  **Diff** on a candidate to compare the file _as it was introduced_ against that predecessor
  directly (the file's first commit otherwise reads as a plain creation, so the rename diff is
  opt-in rather than guessed).
- **Deep-linkable state**:
  `/r/:owner/:repo?ref=<ref>&path=<file>&at=<sha>&view=diff&line=42` — refresh, share, and use
  browser back/forward to step through previously viewed files, historical versions, diffs and
  annotations. Blame annotations are on by default; add `blame=0` to share a unified diff or plain
  file view. `base=<path>` diffs the file against a chosen predecessor instead of the commit's own
  changes (what the candidate **Diff** action sets).
- **Export a Trace**: when a hunk _Trace_ is active, **Copy** in its banner puts the traced
  commits on the clipboard as a Markdown list (sha-linked, with authors and dates) — a shareable
  record of what shaped those lines.
- **Honest file handling**: UTF-8 decoding, binary detection (NUL-byte heuristic, like git),
  a 2 MB size guard with a link out to GitHub, and per-snapshot content caching.
- **Specific error states**: not found, invalid ref, empty repository, network failure, and
  GitHub's unauthenticated rate limit (with its reset time).
- **Personal access tokens (optional)**: a collapsible section on the start page stores a token per
  provider — GitHub (60 → 5,000 requests/hour, private repos with the `repo` scope), GitLab
  (`read_api`, sent as `PRIVATE-TOKEN`), Bitbucket (a repository/workspace access token sent as
  Bearer, or a `user:app_password` pair sent as Basic) and Azure DevOps (`Code (Read)`, Basic
  auth). Self-hosted instances keep their **own token per host**. Tokens live only in this
  browser's localStorage and go only to the matching instance's API; rate-limit and access errors
  say when adding — or fixing — a token would help.
- **Installable PWA / offline app-shell**: a web app manifest and icon make Time Tracer installable
  to the home screen / desktop, and a service worker caches the app shell so it launches and runs
  offline (after the first visit). The worker only ever caches the app's own static assets —
  cross-origin provider API calls and repository content are never intercepted or cached.
- **Recent repositories** remembered locally (localStorage), self-hosted instances included.

> GitHub's unauthenticated API allows **60 requests/hour per IP** (5,000/hour with a personal
> access token). Time Tracer uses one request
> for metadata, one for the full tree, one per opened file (cached), one per history page and one
> per time-travel hop (cached per commit), so normal browsing stays well within the budget. Blame
> and Trace walk the same per-version cache, so annotating and filtering revisit versions for free.

## Tech stack

- **Angular 21** — zoneless change detection, signals everywhere, standalone components, signal
  inputs/outputs, the built-in control flow syntax, and router component-input binding.
- **Tailwind CSS v4** via `@tailwindcss/postcss` (configured in `.postcssrc.json`).
- **isomorphic-git** (lazy-loaded) to parse local repositories in the browser.
- **Vitest** through `ng test` (jsdom), including router-driven integration tests of the viewer
  and local-provider tests that build a real git repo in an in-memory filesystem.

## Architecture

```
src/app/
├── app.config.ts            # zoneless + router + provider registration
├── app.routes.ts            # '/' loader · '/r/:owner/:repo' viewer
├── core/
│   ├── models.ts            # RepoSlug, TreeEntry, RepoFile, CommitInfo, errors…
│   ├── git/
│   │   ├── access-tokens.ts # per-host/provider PAT store (localStorage)
│   │   ├── git-provider.ts  # GitProvider interface · GIT_PROVIDERS token · registry
│   │   ├── github/          # URL parser + REST implementation (github.com + Enterprise)
│   │   ├── gitlab/          # URL parser + REST v4 implementation (gitlab.com + self-hosted)
│   │   ├── bitbucket/       # Cloud (REST 2.0) + Server/Data Center (REST 1.0) providers
│   │   ├── azd/             # Azure DevOps URL parser + REST 7.1 implementation
│   │   └── local/           # FS-Access filesystem + isomorphic-git provider
│   ├── store/
│   │   ├── repo-store.ts    # signals store: load lifecycle, tree, selection, file +
│   │   │                    # history caches, time-travel (viewAt) state
│   │   └── recent-repos.ts  # localStorage-backed recents
│   └── util/                # pure helpers: tree building, diffing, line tracking, similarity
└── features/
    ├── loader/              # landing page with URL form, examples, recents
    └── viewer/              # split pane: header, file tree, file view, history panel
```

Design decisions that matter for what's next:

- `GitProvider` is an injection-token-based abstraction — new hosts drop in without touching the
  UI. A provider derives its API base and token from the `RepoSlug`, which carries an optional
  `host` (instance origin); that one field is what lets the GitHub and GitLab readers serve both
  the public host and self-hosted instances. `listCommits` and `getFileAtRef` are the primitives
  blame, diff and trace all traverse with.
- Historical file versions are fetched with **one request per hop** (the contents API at a commit
  sha) and cached per `<sha, path>`, so walking back through time is cheap and revisits are free.
- The `RepoStore` guards every async flow with a load sequence number — stale responses from
  abandoned navigations are dropped instead of clobbering state.

## Development

```bash
npm install
npm start          # dev server on http://localhost:4200
npm test           # vitest unit + integration tests
npm run build      # production build into dist/
```

## Roadmap

1. ~~**Commit timeline** — per-file commit list with time travel to any version.~~ ✅ Done.
2. ~~**File diffs between commits** — compute hunks client-side from two blob versions.~~ ✅ Done
   (minimal Myers diff engine in `core/util/diff.ts`, surfaced as the _Changes_ view).
3. ~~**Blame annotations** — per-line commit attribution in the line-number gutter.~~ ✅ Done
   (diff-walk attribution with progressive rendering; click an annotation to open the commit).
4. ~~**Recursive time travel** — "blame previous revision" per hunk, IntelliJ-style.~~ ✅ Done
   (line-targeted blame jumps + per-hunk ◂ Before).
5. ~~**Rename candidates** — rank likely predecessors where a file's history ends.~~ ✅ Done
   (provider rename detection + identical blobs + similarity heuristics, journey continues in the
   predecessor's timeline).
6. ~~**Per-hunk history filter** — trace a hunk's lines through time, `git log -L`-style.~~
   ✅ Done (range-tracking walk in `core/util/line-range.ts`, surfaced as _Trace_ on every hunk;
   hunk-origin search for moved blocks via `core/util/similarity.ts`).
7. **Branch/ref switcher** — pick branches and tags from the viewer header (any ref already works
   via the `?ref=` query param).
8. ~~**More sources** — GitLab, Bitbucket (Cloud + Server/Data Center) and Azure DevOps providers,
   self-hosted GitHub Enterprise / GitLab instances by custom base URL, and local folders, all
   behind the `GitProvider` interface.~~ ✅ Done.
9. ~~**Access tokens** — an optional personal-access-token input for a higher hosted-API
   budget.~~ ✅ Done (GitHub + GitLab + Bitbucket + Azure DevOps, a token per self-hosted instance,
   stored locally, private repositories included).
10. ~~**Installable PWA / offline app-shell** — manifest, icon and a service worker that caches the
    app shell (never repository content).~~ ✅ Done.
11. ~~**Row virtualization** — keep huge blamed files smooth by rendering only the visible rows.~~
    ✅ Done.
12. **Quality of life** — fuzzy file finder (✅ done — `Ctrl/⌘ P` quick open with
    boundary-aware ranking, `core/util/fuzzy.ts`); syntax highlighting next.
13. ~~**Keyboard shortcuts** — step older/newer, toggle blame, history and the file tree, and
    dismiss overlays from the keyboard; a natural companion to the `Ctrl/⌘ P` finder.~~ ✅ Done
    (`←`/`→`, `b`/`h`/`o`/`t`, `Ctrl/⌘ P`, `Esc`; one guarded `(document:keydown)` on the viewer).
14. **Word-level diff** — intra-line +added/−removed highlighting layered on the line-level Myers
    engine in `core/util/diff.ts`.
15. ~~**Code ownership** — fold the per-line blame attribution into a per-file and per-folder
    authorship summary (share by author, last touched, bus-factor) — "who do I ask about this?".~~
    ✅ Done (`core/util/ownership.ts`, surfaced as the _Owners_ panel; the per-file summary is free
    from blame, the per-folder scan is opt-in and capped).
16. **Pickaxe search** — `git log -S`/`-G` in the browser: the commits that added or removed a
    string or regex, reusing the diff engine and per-version cache the _Trace_ walk already relies
    on.
17. **Function/symbol history** — follow a function's line range backwards through time
    (`git log -L :func:file`), extending the range-tracking walk in `core/util/line-range.ts`.
18. **Commit & release context** — a per-commit page listing everything a commit touched
    (`getCommitFiles` already exists) and a "first tag/release that contains this commit" lookup,
    answering "which version shipped this line?".
19. **Richer content** — render Markdown and show images (with image-vs-image diffs) instead of the
    binary placeholder; in-file find (`Ctrl/⌘ F`) with a minimap marking matches, blame age and
    hunks; an age-heatmap view that tints lines by age.
20. **Sharing** — ✅ Markdown export of an active _Trace_ (`core/util/trace-export.ts`,
    `core/util/clipboard.ts`). A permalink / "cite this line" affordance was tried and reverted
    (not enough value for the toolbar noise); native provider permalinks (`#L42`) and a
    re-runnable trace deep link remain options.
21. **Off-main-thread analysis & more hosts** — move blame/Trace/pickaxe walks to a Web Worker so
    long histories stay responsive, and add Gitea / Forgejo / Codeberg behind the `GitProvider`
    interface.
22. **Repository Insights** — a metrics view over the history. ✅ **Change coupling**
    (`core/util/co-change.ts`), a **hotspot treemap + list** (`core/util/hotspots.ts`,
    `core/util/treemap.ts`), a **team collaboration / social graph** (`core/util/team-graph.ts` —
    who works with whom, by shared file authorship), a **knowledge-loss / turnover risk map**
    (`core/util/knowledge.ts`), and **code survival / age cohorts** (`core/util/survival.ts`, the
    _Age_ tab, for local repositories) — a Git-of-Theseus-style cohort stack by year added, the
    authorship of the code alive today, and a **Kaplan–Meier survival curve** with the repo's code
    half-life against Bernhardsson's "half-life of code" benchmark (≈6-year half-life, ≈40% alive at
    10 years) — all from the same commit walk; next: a contributor leaderboard with a bus-factor
    "what if they left?" simulation, and a hierarchically zoomable treemap.
