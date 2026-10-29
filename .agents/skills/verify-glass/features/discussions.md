# Existing Discussions

In Changes, each Discussion on a line shows under that line, on its side of the diff, headed "Unresolved thread on line +9" (or "−9" on the old side), with every comment's avatar, author, time, and body rendered as GitHub renders its Markdown; a rail joins the avatars. A resolved Discussion starts closed as "Resolved thread on line … · N comments" and opens on click. Overview lists, under the description, "Comments and Reviews": comments on the PR itself and submitted Reviews with their decision (reviewed, approved these changes, requested changes, or had a review dismissed), oldest first. Below it, "Outdated Discussions" lists Discussions that can't sit on a line of the current diff: outdated ones and ones in a file whose diff isn't shown, with the hunk they were written against, and ones on a whole file. Reload brings in Discussions and Replies added on GitHub since.

## Sub-features

- `discussion-inline` shows line Discussions under their lines, old side or new, in Unified and Split.
- `discussion-resolved` shows a resolved Discussion closed, and opens it.
- `discussion-timeline` lists comments on the PR and Reviews with their decisions.
- `discussion-outdated` lists outdated and whole-file Discussions apart from the diff.
- `discussion-reload` shows a Reply added on GitHub after Reload.

## How to get to it (user POV)

- Open a PR (see [PR workspace](./pr-workspace.md)); Overview shows the timeline and outdated list.
- Choose `Changes`, or a file in the sidebar, to see line Discussions.

## Driving it with glass-verify

Preconditions: a real-GitHub run (`node $V launch`). The kept probe repo `k-dang/glass-api-probe` holds every kind: PR #2 has a comment on the PR, a thread with a Reply and a suggested change on `renamed.txt` line 2, a resolved thread on deleted `c.txt` line 1, and a whole-file thread on `image.bin`; PR #1 has two Reviews with summaries, an outdated thread on `a.txt`, and a thread on `b.txt`'s old line 2.

- **Timeline and outdated (`discussion-timeline`, `discussion-outdated`).** Open PR #1, `wait --text "Finish Review"`, screenshot: two "reviewed" entries, then `a.txt:2` marked Outdated with its hunk. Open PR #2: the comment on the PR shows a highlighted code block and a task list, and `image.bin` is marked Whole file.
- **Inline (`discussion-inline`).** On PR #2, `click --role treeitem --name renamed.txt`, `wait --text "A reply"`, screenshot. On PR #1, `click --role button --name Split`, `click --role treeitem --name b.txt`, then screenshot: the comment sits in the left column under line 2.
- **Resolved (`discussion-resolved`).** On PR #2, `click --role treeitem --name c.txt`, screenshot the closed row, `click --role button --name "Resolved thread on line −1 · 1 comment"`, `wait --text "On the deleted c.txt"`, screenshot.
- **Reload (`discussion-reload`).** With PR #1 open, reply to the `b.txt` thread on GitHub (`addPullRequestReviewThreadReply` through `gh api graphql`), `click --role button --name Reload`, `wait --text <reply text>`.
- **Proof.** Screenshots of each state above.

## Gotchas

- Snapshots and `text` include Discussions' text but not diff lines; judge placement from screenshots.
- Every Reply adds an empty Review on GitHub; the timeline leaves those out by design.
