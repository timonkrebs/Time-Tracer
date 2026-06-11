# Time Tracer

Explore any public GitHub or GitLab repository — or a git repository on your own disk — and
travel back through its history change by change.

Time Tracer is a **client-only** Angular app: there is no backend. Hosted repositories are read
through the GitHub/GitLab public REST APIs; local folders are read directly via the File System
Access API and parsed with isomorphic-git. Nothing you browse ever leaves your machine.

## Vision

The end goal is an interactive **git blame explorer** in the spirit of IntelliJ's annotate view:

- Annotate a file and step **backwards in time hunk by hunk** — select a hunk, jump to the state
  of the file *before* the commit that introduced it, and keep digging recursively.
- **Don't stop at renames.** Where `git blame` normally ends at a rename or content move, Time
  Tracer will present a ranked list of **candidate predecessor files** so the journey back in time
  can continue across renames and code moves.

The current milestone is the foundation for that: loading a repository, resolving refs, browsing
the tree and reading file contents — with domain models and provider APIs already shaped around
commits and time travel (see `listCommits` on the provider interface).

## Current features

- **Load a repo** from `owner/repo`, any `github.com` URL (`/tree/<ref>`, `/blob/<ref>/<path>`,
  commit URLs, `.git`, SSH form), a `raw.githubusercontent.com` URL — including branch names
  containing `/`, resolved against the repo's real refs — or any `gitlab.com` URL
  (`…/gitlab-org/gitlab.git`, `/-/tree/...`, `/-/blob/...`, nested groups included).
- **Open local repositories** like vscode.dev: pick a folder with the File System Access API and
  Time Tracer parses its `.git` directly in the browser with isomorphic-git — full tree, history,
  diffs, blame and rename candidates, completely offline and read-only. Folder handles persist
  across reloads (IndexedDB); a one-click "Reconnect folder" re-grants permission.
- **Desktop-first split-pane viewer**: resizable file tree (drag the divider, double-click to
  reset) next to a file view with a line-number gutter — the future home of blame annotations.
- **Per-file commit history**: a History panel lists the commits that touched the selected file
  (paginated), with author and relative date. Its open/closed state is remembered, so it can stay
  open permanently across files and sessions.
- **Time travel**: pick any commit to see the file exactly as it was, with a banner showing where
  in time you are and a one-click way back to the tip. The ← Older / Newer → steppers are always
  visible (only the dead direction is disabled) and work straight from the current version,
  auto-loading more history when you walk past the loaded pages. Like `git log -- <path>`,
  history currently stops at renames — continuing past them is a later milestone.
- **Changes view (default)**: picking a commit opens what that commit changed in the file — a
  unified diff against its first parent, computed client-side with a minimal Myers diff (dual
  line-number gutter, hunk headers, +added/−removed stats, root/merge commits handled). Switch to
  *File* to read the full version instead; your last File/Changes choice is remembered.
- **Blame annotations everywhere**: the *Blame* toggle is available in both views. In the file
  view it annotates every line with the commit that introduced it (`dd.mm.yyyy author` on every line, IDE-style, colour-coded
  older→newer, IntelliJ-style block grouping). In the changes view it switches to a **split
  view** — the version *before* the commit on the left, *after* on the right, removes/adds
  aligned side by side, and **both sides carry their own blame gutters**. Attribution is computed
  client-side by walking the file's history with the minimal diff, streams in progressively, and
  works at any historical version. Lines older than the loaded history pages are marked and
  resolve incrementally as more pages load.
- **Recursive time travel, hunk by hunk**: clicking a blame annotation opens the introducing
  commit's diff *scrolled to that exact line*; every hunk in a diff offers **◂ Before** — jump to
  the parent version, annotated, at the hunk's old position. Blame → commit → before → blame
  chains indefinitely, each step deep-linked (`line=` highlights and scrolls).
- **Rename candidates**: where a file's recorded history ends, the History panel can search the
  commit just before it for likely predecessors — GitHub's own rename detection, identical blobs
  in the parent tree, and name/size/content-similarity heuristics, each ranked with a confidence
  score. Picking a candidate continues the journey in the predecessor's own timeline (anchored at
  its last change before the rename), with history, blame and steppers all working there.
- **Deep-linkable state**:
  `/r/:owner/:repo?ref=<ref>&path=<file>&at=<sha>&view=diff&blame=1&line=42` — refresh, share,
  and use browser back/forward to step through previously viewed files, historical versions,
  diffs and annotations.
- **Honest file handling**: UTF-8 decoding, binary detection (NUL-byte heuristic, like git),
  a 2 MB size guard with a link out to GitHub, and per-snapshot content caching.
- **Specific error states**: not found, invalid ref, empty repository, network failure, and
  GitHub's unauthenticated rate limit (with its reset time).
- **Recent repositories** remembered locally (localStorage).

> GitHub's unauthenticated API allows **60 requests/hour per IP**. Time Tracer uses one request
> for metadata, one for the full tree, one per opened file (cached), one per history page and one
> per time-travel hop (cached per commit), so normal browsing stays well within the budget.

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
│   │   ├── git-provider.ts  # GitProvider interface · GIT_PROVIDERS token · registry
│   │   ├── github/          # URL parser + unauthenticated REST implementation
│   │   ├── gitlab/          # gitlab.com URL parser + REST v4 implementation
│   │   └── local/           # File System Access fs + isomorphic-git provider
│   ├── store/
│   │   ├── repo-store.ts    # signals store: load lifecycle, tree, selection, file +
│   │   │                    # history caches, time-travel (viewAt) state
│   │   └── recent-repos.ts  # localStorage-backed recents
│   └── util/                # pure helpers: tree building, decoding, relative time
└── features/
    ├── loader/              # landing page with URL form, examples, recents
    └── viewer/              # split pane: header, file tree, file view, history panel
```

Design decisions that matter for what's next:

- `GitProvider` is an injection-token-based abstraction — GitLab/Bitbucket can be added without
  touching the UI. `listCommits` and `getFileAtRef` are the same primitives the blame milestone
  will traverse with.
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
   (minimal Myers diff engine in `core/util/diff.ts`, surfaced as the *Changes* view).
3. ~~**Blame annotations** — per-line commit attribution in the line-number gutter.~~ ✅ Done
   (diff-walk attribution with progressive rendering; click an annotation to open the commit).
4. ~~**Recursive time travel** — "blame previous revision" per hunk, IntelliJ-style.~~ ✅ Done
   (line-targeted blame jumps + per-hunk ◂ Before).
5. ~~**Rename candidates** — rank likely predecessors where a file's history ends.~~ ✅ Done
   (provider rename detection + identical blobs + similarity heuristics, journey continues in the
   predecessor's timeline).
6. **Branch/ref switcher** — pick branches and tags from the viewer header (any ref already works
   via the `?ref=` query param).
7. ~~**More sources** — GitLab provider and local folders behind the `GitProvider` interface.~~
   ✅ Done.
8. **Quality of life** — syntax highlighting and an optional personal-access-token input for a
   higher hosted-API budget.
