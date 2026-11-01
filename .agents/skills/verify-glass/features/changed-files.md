# Changed files

An open PR workspace has three tabs in its header: Overview (the description), Changes, which shows the PR's total added and deleted lines, and Files (see [Full context and repository files](./full-context.md)). Changes stacks every changed file's diff at the pinned Revision in one scroll, each under a header with its change type, path (a rename shows old → new), and line counts. Files with a diff start expanded; a chevron opens or closes any file with a diff. Collapsing a file whose header is stuck at the top keeps that header at the top. Binary files, diffs too large to show, empty files, and files with no text changes show their reason in the header instead of a diff. Unified and Split switch the diff layout. The workspace tabs show their icons and text labels, with a separate row below the PR metadata in narrower windows. The sidebar shows Tree and Notes with visible labels beside their icons; Notes keeps its count. The Tree tab shows neutral filenames and muted line counts, with color reserved for compact change indicators; the diffs come in the tree's order, folders first. Choosing a file selects it, opens it if collapsed, and scrolls Changes to it, from either tab. Keyboard selection in the tree jumps immediately; mouse selection scrolls smoothly. Scrolling Changes leaves the selection alone. With focus in the diffs, Ctrl+F (⌘F on macOS) finds text across every file, collapsed ones included.

## Sub-features

- `files-tree` lists every changed file with its change type and line counts, in the same order as the diffs; choosing one opens it and scrolls Changes to it.
- `files-diff` stacks each file's diff, with renames as "old → new", in Unified or Split.
- `files-placeholders` shows "Binary file not shown", "Diff too large to show", "Empty file", and "No text changes" (a pure rename or a mode change) in the file's header.
- `files-find` searches every diff's lines with match case, whole word, and regex, shows "N of M", and opens a collapsed file holding the current match.

## How to get to it (user POV)

- Open a PR (see [PR workspace](./pr-workspace.md)), then choose `Changes` in its header, or a file in the sidebar tree.
- Choose the chevron beside a file's badge to open or close its diff.
- Choose `Unified` or `Split` above the files.
- Choose `Overview` to return to the description.

## Driving it with glass-verify

Preconditions: a real-GitHub run (`node $V launch`) and access to the kept probe repo `k-dang/glass-api-probe`. PR #2 (branch `file-kinds`) holds a deleted, empty, binary, too-large, purely renamed, and renamed-and-edited file. For scrolling, use a PR with long diffs, such as `k-dang/project-glass` PR #8. For a repeatable workload, a fake-GitHub run (`node $V launch --github fake`) lists `octo-org/glass#101`, "Wide change across 150 files": 150 generated files of 40 lines each, which fills the diff caches the same way every time.

- **Tree (`files-tree`).** Open `https://github.com/k-dang/glass-api-probe/pull/2`, `wait --text "Tree"`, then `snapshot`: each `treeitem` carries its counts and change letter.
- **Diffs (`files-diff`, `files-placeholders`).** `click --role tab --name "Changes …"` (the name includes the totals; take it from a snapshot), then screenshot. Every line of a hunk shows on its own row; placeholder files show their reason in the header. `click --role button --name Split` switches layout.
- **Choosing.** On a long PR, `click --role treeitem --name <file>`, then screenshot once the smooth scroll settles: that file's header is at the top, open even if previously collapsed, and its row is selected. Collapse it with its chevron: the next diff is the next file in the tree (on PR #8, `toggle.tsx` is followed by `App.tsx`, not `plural.ts`).
- **Keyboard choosing.** With focus on a tree file on PR #8, send End then Enter over CDP: Changes jumps directly to the last file without sliding through the intervening diffs. Home, ArrowDown, Enter returns to the first file immediately. Enter again reselects it without motion. Clicking `README.md` afterward still scrolls smoothly.
- **Notes.** On probe PR #2, choose `tab "Notes 2"` in the sidebar: each line Discussion and Draft is listed under its file. `click --role button --name "Show Discussion on renamed.txt line 2"`: Changes opens with that line highlighted and its thread below.
- **Filter and search.** In the sidebar's `Tree` tab, `type --role textbox --name "Search…" --text ren`: the tree narrows to the three paths holding "ren". Choosing one selects it and keeps the search; Escape in the search box clears it and shows every file again. `click --role button --name "Filter by change type"`, then `click --role checkbox --name "Deleted 2"`: only the deleted files remain, and the button reads "Filter by change type, 1 chosen" with a dot. Unchecking it shows every file again. Alt-click (show one type only) needs a modifier `glass-verify` can't send.
- **Toolbar.** On PR #8's Changes: `click --role button --name "Collapse all files"` collapses every file; the same button then reads "Expand all files". "Show split diffs" switches layout. "Display settings" opens checkboxes for Word wrap, Line numbers and Backgrounds, and Bars / + / − / None change markers; each applies to every file at once. With wrap off, choosing a file in the tree still lands its header at the top.
- **Anchoring.** Scroll into the middle of a long diff with `scroll --by 9000` so its header is stuck at the top, then collapse it from that header: its header stays at the top with the next file below.
- **Find (`files-find`).** On PR #8's Changes, click a diff line, then send Ctrl+F as raw CDP `Input.dispatchKeyEvent` (`key: "f"`, `code: "KeyF"`, `modifiers: 2`; `4` on macOS) and the query with `Input.insertText`. Screenshot: the find panel at the top right reads "1 of N" with matches highlighted. Enter moves to the next match. After "Collapse all files", a query opens the file holding its first match. Escape removes the panel. In the Files tab, Ctrl+F opens nothing.
- **Proof.** Snapshots and screenshots of the tree, the stacked diffs, the placeholders, and manual collapse and expand.

## Gotchas

- `text` and snapshots don't include a diff's lines, so judge diffs from screenshots.
- A diff's lines all running together on one row means its styles failed to load.
- Editing most of a renamed file makes Git, and so GitHub, report it as a delete plus an add.
- The tree and the diffs render only what's on screen: a tree row scrolled out of view has no `treeitem` to click.
- `type` presses Ctrl+A before pasting, and Ctrl+A in an empty `Search…` field selects every visible row, so a typed search starts with extra rows selected. Choose a row first to reset the selection.
