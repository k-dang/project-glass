# Drafts

In Changes, hovering a line inside a diff hunk shows a `+` in its gutter; clicking it opens a dashed Draft card under the line, headed "Draft on line +N" (or "−N" on the old side), with the cursor in its text field. Typed text shows "Not saved" and a Save Draft button; Enter (or Save Draft) saves it, showing "Saving…", then "Saved privately" once it is on the user's GitHub pending review. Option+Enter adds a line. Edits made while a save is out stay "Not saved" until the next save. A failed save shows "Couldn't save", the reason, and Retry, keeping the text. Saving a saved Draft with its text cleared deletes it from GitHub, leaving the empty card. Until a Draft's first save starts, its card also offers Ask the agent (⌘Enter, Ctrl+Enter elsewhere; otherwise those keys save), which drops the Draft and asks its text as an Ask on the same line: a private answer under it, with nothing sent to GitHub. The `+` on context expanded around a hunk does nothing, since GitHub won't take a comment there. While a Draft with text is the only one on the PR, its card also offers Comment (Shift+Enter), which saves it and publishes it at once as a comment Review without the Review summary, then reloads; with a second Draft the button is gone. Once GitHub takes a Review, by Comment or Finish Review, each published Draft's card becomes its Discussion on its line, the comment marked "Published" and with no Reply box until the reload loads the Discussion. The header's Finish Review button counts Drafts, and Overview lists them under "Your Drafts · N", each with its file (which opens it in Changes) and Delete. After a push and Reload, Drafts GitHub reports outdated move to "Flagged drafts", each with the hunk it was written against. Reopening the PR, on any machine, shows the same Drafts. Reload, opening a PR, or submitting a Review locks Drafts until it finishes, first saving any "Not saved" text, and asks before discarding Drafts whose save failed. A Draft whose Review was submitted elsewhere is never edited or deleted on GitHub: editing it saves its text as a new Draft, and deleting it only drops it from Glass.

## Sub-features

- `draft-create` opens a Draft from the gutter on either side and saves it on Enter.
- `draft-publish-now` publishes a lone Draft with Comment.
- `draft-edit` saves changed text; `draft-delete` removes a Draft, the last taking the pending review with it.
- `draft-context` ignores the `+` on expanded context.
- `draft-stale` refuses a new Draft once the PR has moved past the pinned Revision, with Retry and a Reload hint.
- `draft-flagged` lists outdated Drafts with their hunk after Reload.
- `draft-adopt` loads Drafts already on the pending review, including ones written on GitHub.

## How to get to it (user POV)

- Open a PR (see [PR workspace](./pr-workspace.md)), choose a file in the sidebar, hover a line, click `+`.
- Overview lists the Drafts and Flagged drafts.

## Driving it with glass-verify

Preconditions: a real-GitHub run (`node $V launch`) as `k-dang`, who can push to the kept probe repo. Its PR #3 (`drafts-change` into `drafts-base`) changes line 20 of the 40-line `long.txt`, so lines 1–16 are context to expand. Start and end with no pending review on it: `gh api graphql` `pullRequest(number: 3) { reviews(states: PENDING) { totalCount } }`.

- **The gutter `+` isn't in the accessibility tree.** Over raw CDP (`doctor` prints the port), scroll the row (`diffs-container` shadow root, `[data-content] [data-line-index="<i>"]`) into view, dispatch `Input.dispatchMouseEvent` `mouseMoved` over it, then press and release on `[data-gutter-utility-slot]`. The first synthetic move after a click elsewhere only wakes the gutter: repeat until `snapshot` shows `textbox "Draft on long.txt line +18"`.
- **Create and edit (`draft-create`, `draft-edit`).** Type with CDP `Input.insertText` (it goes to the focused field, proving focus), `wait --text "Not saved"`, press Enter, `wait --text "Saved privately"`; confirm the body, line, and `diffSide` with `gh api graphql` `reviewThreads { line diffSide comments { nodes { body state } } }`.
- **Context (`draft-context`).** Click the `+` on line 5 after expanding `long.txt`: no new textbox.
- **Stale (`draft-stale`).** With PR #3 open, push a commit to `drafts-change` from a temporary clone, then create a Draft: `wait --text "The pull request has new commits"`.
- **Flagged (`draft-flagged`).** Create a Draft on line +20, push a commit changing line 20, `click --role button --name Reload`, Overview: `wait --text "Flagged drafts"`.
- **Comment (`draft-publish-now`).** On the own-PR probe in [Submitting a Review](./submit-review.md) (PR #4), add one Draft, open the PR, choose Changes: `snapshot` shows `button "Comment with Draft on submit.txt line +2"`. Clicking it publishes a real comment: the card turns into "Unresolved thread on line +2" with the comment marked "Published", and the Reply box appears once the reload finishes; delete it afterwards with `deletePullRequestReviewComment`.
- **Delete (`draft-delete`).** `click --role button --name "Delete Draft on long.txt line +18"`; the pending review's `totalCount` drops to 0 after the last.
- **Proof.** Screenshots of each state and the `gh api` answers.

## Gotchas

- Every Draft created on the probe repo is real; delete them (in Glass or with `deletePullRequestReviewComment`) before stopping.
- After a failed save, Reload opens the `Discard unpublished feedback?` dialog. Choose Cancel to keep editing or Discard feedback to reload. Escape in a nonempty Draft opens `Delete this Draft?`; Cancel returns focus to the editor, and Delete Draft removes it. Escape dismisses an empty Draft immediately.
- A push to `drafts-change` moves the probe PR for later runs too; that's fine, it only needs line 20 to differ from the base.
