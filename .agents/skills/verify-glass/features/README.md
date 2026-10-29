# Glass verification map

This directory is the maintained source for verifying Glass's user-facing behavior. Read this index, then use the matching feature file as the recipe. `$V` below is `.agents/skills/verify-glass/scripts/glass-verify.ts`, run with `node` from the repo root.

## Baseline preconditions

- Dependencies installed (`pnpm install`) and the toolchain from `mise.toml` active.
- A run started by `node $V launch ...` in this session, with the GitHub mode the recipe names.
- `node $V doctor` passes for that run.
- Never drive a Glass window this verification did not launch.

## Driving conventions

- Start each recipe from a fresh `launch` unless it says otherwise; the connection status loads once at startup.
- Target elements by accessible role and name from `node $V snapshot`.
- Wait for visible text with `node $V wait --text`, never a fixed sleep.
- Change GitHub's answer with `node $V fake-github <mode>`; it takes effect on the next request.
- `node $V stop` after each run. It keeps `.verify/<id>/evidence/` and removes the rest.

## Proof and skip reporting

- UI proof is a snapshot (`.aria.txt`) and a screenshot of each state the recipe passes through.
- A GitHub round trip is proven by `fake-github.log` lines, or for real GitHub by the login shown matching `gh api user --jq .login`.
- Record the run ID and entry point with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition. Do not report a skipped entry point as verified through another.

## Feature entry contract

Each feature file has an H1 title, one paragraph of user-visible behavior, then exactly four H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with glass-verify`, `Gotchas`. Keep implementation details out; name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [GitHub connection](./github-connection.md): the rail avatar status that shows who Glass is signed in as, or a problem alert explaining why it can't be, with Try again.
- [PR list](./pr-list.md): the Needs review, My PRs, and Reviewing lists grouped by followed repository, opening a PR from it, and Back to PRs without losing feedback silently.
- [PR workspace](./pr-workspace.md): pasting a PR URL to open its metadata and description pinned to a Revision, Reload, and the open errors.
- [Activity log](./activity-log.md): the read-only Activity area listing what the user did in Glass by day, newest first, with Load more.
- [App navigation](./app-navigation.md): the icon rail, app routes, keeping a PR workspace while switching areas, and Dashboard's Continue card restoring the Saved place.
- [Changed files](./changed-files.md): the changed-files tree and each file's diff or placeholder.
- [Tours](./tours.md): generating and reading a Tour through a local fake provider without model charges, or checking a live provider explicitly.
- [Full context and repository files](./full-context.md): expanding a diff's collapsed context up to the whole file, and the Files tab for reading any file at the pinned head.
- [Agent composer](./agent-composer.md): Queueing, Steering, and stopping a running Agent Turn from its composer, on the fake backend's demo Agent.
- [Permission requests and Questions](./agent-requests.md): a Claude Code Agent's Permission mode, answering its Permission requests and Questions from the transcript, and stopping while one waits, on the real pinned `claude` against a fake Anthropic API.
- [Existing Discussions](./discussions.md): line Discussions in the diff with their resolved state, comments and Reviews on Overview, and the outdated list.
- [Drafts](./drafts.md): starting a Draft from a diff line's gutter, saving to the pending review on Enter with its Feedback state, delete, the Drafts list and count, and Flagged drafts after Reload.
- [Replies](./replies.md): replying to a Discussion, published at once with its Feedback state, refused while the user has Drafts, Retry, and Reload keeping unsent text.
- [Submitting a Review](./submit-review.md): submitting every Draft as one Review with a Review decision and an optional summary, comment-only on the user's own PR, and the stale-Revision block with Reload.
- [To-dos](./to-dos.md): the user's own to-do list in its rail area: adding, editing title and notes, checking off into Done and reopening, deleting, and keeping them across a backend restart.
- [App lifecycle](./app-lifecycle.md): opening the window, the backend starting with it, logs, the error screen when the backend fails to start or crashes, relaunching, and quitting stopping the backend.
- [Backend access](./backend-access.md): the standalone backend's secret and origin checks, for when it is promoted to a server.
