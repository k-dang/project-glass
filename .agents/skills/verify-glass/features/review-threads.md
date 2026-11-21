# Existing Review threads

In Changes, each Review thread on a line shows under that line, on its side of the diff, headed "Unresolved Review thread on line +9" (or "−9" on the old side), with every comment's avatar, author, time, and body rendered as GitHub renders its Markdown; a rail joins the avatars. A resolved Review thread starts closed as "Resolved Review thread on line … · N comments" and opens on click. Each Review thread's Resolve button resolves it on GitHub, and Unresolve reopens it. Overview lists, under the description, "Comments and Reviews": comments on the PR itself and submitted Reviews with their decision (reviewed, approved these changes, requested changes, or had a review dismissed), oldest first. Below it, "Outdated Review threads" lists Review threads that can't sit on a line of the current diff: outdated ones and ones in a file whose diff isn't shown, with the hunk they were written against, and ones on a whole file. Reload brings in Review threads and Replies added on GitHub since.

## Sub-features

- `review-thread-inline` shows line Review threads under their lines, old side or new, in Unified and Split.
- `review-thread-resolved` shows a resolved Review thread closed, and opens it.
- `review-thread-resolve` resolves and unresolves a Review thread.
- `review-thread-timeline` lists comments on the PR and Reviews with their decisions.
- `review-thread-outdated` lists outdated and whole-file Review threads apart from the diff.
- `review-thread-reload` shows a Reply added on GitHub after Reload.

## How to get to it (user POV)

- Open a PR (see [PR workspace](./pr-workspace.md)); Overview shows the timeline and outdated list.
- Choose `Changes`, or a file in the sidebar, to see line Review threads.

## Driving it with glass-verify

Preconditions: a real-GitHub run (`node $V launch --github real`). The kept probe repo `k-dang/glass-api-probe` holds every kind: PR #2 has a comment on the PR, a Review thread with a Reply and a suggested change on `renamed.txt` line 2, a resolved Review thread on deleted `c.txt` line 1, and a whole-file Review thread on `image.bin`; PR #1 has two Reviews with summaries, an outdated Review thread on `a.txt`, and a Review thread on `b.txt`'s old line 2.

- **Timeline and outdated (`review-thread-timeline`, `review-thread-outdated`).** Open PR #1, `wait --text "Finish Review"`, screenshot: two "reviewed" entries, then `a.txt:2` marked Outdated with its hunk. Open PR #2: the comment on the PR shows a highlighted code block and a task list, and `image.bin` is marked Whole file.
- **Inline (`review-thread-inline`).** On PR #2, `click --role treeitem --name renamed.txt`, `wait --text "A reply"`, screenshot. On PR #1, `click --role button --name "Show split diffs"`, `click --role treeitem --name b.txt`, then screenshot: the comment sits in the left column under line 2.
- **Resolved (`review-thread-resolved`).** On PR #2, `click --role treeitem --name c.txt`, screenshot the closed row, `click --role button --name "Resolved Review thread on line −1 · 1 comment"`, `wait --text "On the deleted c.txt"`, screenshot.
- **Demo data (`review-thread-inline`, `review-thread-resolved`, `review-thread-resolve`, `review-thread-timeline`).** Without GitHub writes: `node $V launch --backend fake`, open `https://github.com/octo-org/hello-world/pull/1`, and on Overview `wait --text "Comments and Reviews"` (one "reviewed" entry). In Changes, `click --role treeitem --name middleware.ts`, `wait --text "Resolved Review thread on"`, then `click --role button --name "Resolved Review thread on line +14 · 2 comments"` and `wait --text "Behind the load balancer every client shares one IP."`. `click --role button --name "Unresolve Review thread on src/server/middleware.ts line +14"`: it reads "Unresolved Review thread on line +14" and the button becomes `Resolve Review thread on src/server/middleware.ts line +14`; choose it to restore the demo.
- **Reload (`review-thread-reload`).** With PR #1 open, reply to the `b.txt` Review thread on GitHub (`addPullRequestReviewThreadReply` through `gh api graphql`), `click --role button --name Reload`, `wait --text <reply text>`.
- **Proof.** Screenshots of each state above.

## Gotchas

- Snapshots and `text` include Review threads' text but not diff lines; judge placement from screenshots.
- Every Reply adds an empty Review on GitHub; the timeline leaves those out by design.
