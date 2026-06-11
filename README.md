# Time Tracer

Explore any public GitHub repository in your browser — and, as the project grows, travel back
through its history change by change.

Time Tracer is a **client-only** Angular app: there is no backend. Everything is fetched directly
from GitHub's public REST API, so nothing you browse ever leaves your machine.

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
  commit URLs, `.git`, SSH form) or a `raw.githubusercontent.com` URL.
- **Desktop-first split-pane viewer**: resizable file tree (drag the divider, double-click to
  reset) next to a file view with a line-number gutter — the future home of blame annotations.
- **Deep-linkable state**: `/r/:owner/:repo?ref=<ref>&path=<file>` — refresh, share, and use
  browser back/forward to step through previously viewed files.
- **Honest file handling**: UTF-8 decoding, binary detection (NUL-byte heuristic, like git),
  a 2 MB size guard with a link out to GitHub, and per-snapshot content caching.
- **Specific error states**: not found, invalid ref, empty repository, network failure, and
  GitHub's unauthenticated rate limit (with its reset time).
- **Recent repositories** remembered locally (localStorage).

> GitHub's unauthenticated API allows **60 requests/hour per IP**. Time Tracer uses one request
> for metadata, one for the full tree, and one per opened file (cached), so normal browsing stays
> well within the budget.

## Tech stack

- **Angular 21** — zoneless change detection, signals everywhere, standalone components, signal
  inputs/outputs, the built-in control flow syntax, and router component-input binding.
- **Tailwind CSS v4** via `@tailwindcss/postcss` (configured in `.postcssrc.json`).
- **Vitest** through `ng test` (jsdom), including router-driven integration tests of the viewer.

## Architecture

```
src/app/
├── app.config.ts            # zoneless + router + provider registration
├── app.routes.ts            # '/' loader · '/r/:owner/:repo' viewer
├── core/
│   ├── models.ts            # RepoSlug, TreeEntry, RepoFile, CommitInfo, errors…
│   ├── git/
│   │   ├── git-provider.ts  # GitProvider interface · GIT_PROVIDERS token · registry
│   │   └── github/          # URL parser + unauthenticated REST implementation
│   ├── store/
│   │   ├── repo-store.ts    # signals store: load lifecycle, tree, selection, file cache
│   │   └── recent-repos.ts  # localStorage-backed recents
│   └── util/                # pure helpers: tree building, base64/UTF-8/binary detection
└── features/
    ├── loader/              # landing page with URL form, examples, recents
    └── viewer/              # split pane: header, file tree, file view
```

Design decisions that matter for what's next:

- `GitProvider` is an injection-token-based abstraction — GitLab/Bitbucket can be added without
  touching the UI, and it already exposes `listCommits(slug, { ref, path })`.
- All file content is addressed by **blob sha**, so identical content across commits will share
  cache entries once the history view lands.
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

1. **Commit timeline** — branch/ref switcher and a per-file commit list (`listCommits` is ready).
2. **File diffs between commits** — compute hunks client-side from two blob versions.
3. **Blame annotations** — per-line commit attribution in the existing line-number gutter.
4. **Recursive time travel** — "blame previous revision" per hunk, IntelliJ-style.
5. **Rename candidates** — when a file's history ends, rank similar blobs from the parent commit
   (size/content similarity) and offer them as places to continue the journey.
