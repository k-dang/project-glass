# Replies

Every Discussion, in Changes under its line and in Overview's outdated list, ends in a "Reply. It publishes to GitHub right away." box. Typing shows a Reply button (Ctrl+Enter sends too); while sending it reads "Sending…" and the text can't change. Once GitHub confirms, the text leaves the box and the Reply joins the thread's comments marked "✓ Published". A failed Reply keeps its text, says "Couldn't publish your Reply." with why, and the button becomes Retry. While the user has Drafts, GitHub would hold a Reply until the Review is submitted, so Glass refuses it: "GitHub won't publish a Reply while you have Drafts". Reload keeps text not yet published, except on a Discussion deleted since, whose error says so; Replies published since load come back from GitHub as ordinary comments.

## Sub-features

- `reply-publish` publishes a Reply to a line Discussion or an outdated one and shows it Published.
- `reply-blocked` refuses a Reply while the user has Drafts, keeping its text with Retry.
- `reply-retry` publishes a failed Reply on Retry once the cause is gone.
- `reply-reload` keeps unpublished text across Reload and shows published Replies once.

## How to get to it (user POV)

- Open a PR (see [PR workspace](./pr-workspace.md)) with Discussions.
- In Changes, open a file with a line Discussion; or on Overview, scroll to Outdated Discussions.

## Driving it with glass-verify

Preconditions: a real-GitHub run (`node $V launch`) as `k-dang`. PR #1 of the kept probe repo `k-dang/glass-api-probe` has a thread on `b.txt`'s old line 2 and an outdated thread on `a.txt` line 2. Start with no pending review on it (`pullRequest(number: 1) { reviews(states: PENDING) { totalCount } }`), and delete every Reply you publish afterwards with `deletePullRequestReviewComment`.

- **Publish (`reply-publish`).** Open PR #1, `click --role treeitem --name b.txt`, `wait --text "Reload probe reply"`. `type --role textbox --name "Reply to thread on b.txt line −2" --text <text>`, `click --role button --name Reply`, `wait --text Published`. Confirm with `gh api graphql` `node(id: <thread>) { ... on PullRequestReviewThread { comments(last: 1) { nodes { body state } } } }`: `SUBMITTED`. On Overview, the same with `"Reply to thread on a.txt line 2"`.
- **Blocked and retry (`reply-blocked`, `reply-retry`).** Add a Draft to PR #1 with `addPullRequestReviewThread` before opening it, then reply as above: `wait --text "Couldn't publish your Reply"`, and the pending review still holds only the Draft. `click --role button --name "Delete Draft on b.txt line +2"`, then `click --role button --name Retry`: published.
- **Reload (`reply-reload`).** Type a Reply without sending, `click --role button --name Reload`: the box keeps the text, and earlier Replies show once, without Published.
- **Proof.** Screenshots of each state and the `gh api` answers.

## Gotchas

- Right after a file opens in Changes, Diffs is still laying it out: a click can miss the box or button. If typed text doesn't show, `snapshot` and repeat.
- `text` omits textarea contents; read them over raw CDP or from a screenshot.
- GitHub mishandles Replies and Drafts sent at once; never fire `gh api` writes in parallel against the probe PR.
- Every Reply adds an empty Review on GitHub that can't be deleted; the timeline leaves those out.
