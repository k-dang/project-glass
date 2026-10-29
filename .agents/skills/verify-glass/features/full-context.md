# Full context and repository files

In Changes, the collapsed context above, between, and below a file's hunks can be expanded, up to the whole file; the extra lines come from the pinned Revision's base and head, not the PR's latest commit. A file whose full contents can't load leaves its diff as it was and shows "Couldn't expand <path>" with why above the workspace. The Files tab swaps the sidebar for every file in the repository at the pinned head, with the PR's changed files marked, and a search box. Choosing a file shows its contents, highlighted, under its path; a binary or very large file shows "Binary file not shown" or "File too large to show" instead.

## Sub-features

- `context-expand` expands a hunk separator's unmodified lines from the file's full contents.
- `files-browse` lists the repository at the pinned head and opens any file, changed or not.
- `files-placeholders` shows the binary and too-large placeholders in Files.

## How to get to it (user POV)

- Open a PR (see [PR workspace](./pr-workspace.md)), choose `Changes`, then the chevron on a separator such as "31 unmodified lines" or "More unchanged context may be available".
- Choose `Files` in the header, then a file in its tree.

## Driving it with glass-verify

Preconditions: a real-GitHub run (`node $V launch`). `k-dang/project-glass` PR #8 has long files with collapsed context; `k-dang/glass-api-probe` PR #2 has a binary `image.bin`.

- **Expand (`context-expand`).** Open PR #8, choose `Changes`, screenshot. The separator chevrons and tree rows have no accessible name: `node $V doctor` prints the CDP port, then dispatch `Input.dispatchMouseEvent` (moved, pressed, released) at the chevron's position from the screenshot. Screenshot again: README.md's lines 1–31 show above its hunk.
- **Browse (`files-browse`).** `click --role tab --name Files`, `wait --text "Choose a file"`, screenshot: the tree shows the head's files with changed ones marked. Click a row (by CDP, as above), then screenshot: the file shows with line numbers under its path.
- **Placeholders (`files-placeholders`).** Open probe PR #2, choose `Files`, click `image.bin`, `wait --text "Binary file not shown"`.
- **Proof.** Screenshots of a separator before and after expanding, the Files tree, an open file, and the binary placeholder.

## Gotchas

- `text` and snapshots include neither diff lines nor the Files tree, so judge both from screenshots.
- A screenshot taken right after an expand can show the diff before its lines render; take another.
- Files lists the repository once first opened; Reload lists it again at the new head.
