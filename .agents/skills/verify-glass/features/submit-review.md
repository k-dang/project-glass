# Submitting a Review

The PR header has a Finish Review button on every tab, counting the user's Drafts. It opens a "Finish your Review" popover: an optional summary, a Review decision of Comment, Approve, or Request changes, and a Submit Review button (⌘↵ in the summary too) beside a note saying how many Drafts it publishes. On the user's own PR only Comment is offered, with "You opened this pull request, so GitHub takes only comments from you." A comment Review with no Drafts needs a summary; until then the button is disabled. While submitting, the button spins, Drafts and Reload are locked, and clicking outside doesn't close the popover. Once GitHub takes it, the popover closes, a "Review submitted" toast says what was decided and published, and the workspace reloads: the Drafts list is gone, and the Drafts show as published comments in their Discussions, the Review itself on the timeline when it has a summary or approves or requests changes. If the PR has new commits since it opened, the popover says "The pull request has new commits" with a Reload button, and nothing is published. If the backend or GitHub drops the call, GitHub may have taken the Review, so the popover says "Glass lost track of the Review" and offers only Reload; Submit Review stays disabled until then. Any failure leaves every Draft as it was.

## Sub-features

- `review-submit` submits Drafts with a decision and summary, and they come back as published comments.
- `review-no-drafts` submits a Review with no Drafts.
- `review-own-pr` offers only Comment on the user's own PR.
- `review-stale` refuses a Review after a push, offering Reload.
- `review-unsaved` refuses a Review while a Draft hasn't saved, keeping it.

## How to get to it (user POV)

- Open a PR (see [PR workspace](./pr-workspace.md)) and choose Finish Review in its header, from any tab.
- Optionally add Drafts first (see [Drafts](./drafts.md)).

## Driving it with glass-verify

Preconditions: a real-GitHub run (`node $V launch`) as `k-dang`, who authored PR #4 of the kept probe repo `k-dang/glass-api-probe` (`submit-probe` into `main`, adding a 6-line `submit.txt`). Start with no pending review on it: `pullRequest(number: 4) { reviews(states: PENDING) { totalCount } }`. Submitting publishes everything in a pending review, so never submit on a probe PR whose pending review you didn't create. Add Drafts before opening the PR with `addPullRequestReviewThread` (`path: "submit.txt"`, `side: RIGHT`); driving the gutter is covered in [Drafts](./drafts.md).

- **Own PR (`review-own-pr`).** Open PR #4, `click --role button --name "Finish Review"`, `wait --text "Finish your Review"`, `snapshot`: no `Review decision` group, and the own-PR note shows.
- **Submit (`review-submit`).** With two Drafts added, open the PR, `wait --text "Your Drafts"`, `click --role button --name "Finish Review, 2 Drafts"`, `type --role textbox --name "Review summary" --text <text>`, `click --role button --name "Submit Review"`, `wait --text "Review submitted"`, then `wait --text <text>` for the Review on the timeline. Changes shows each Draft as a published thread. Confirm with `gh api graphql` `pullRequest(number: 4) { reviews(last: 1) { nodes { state body comments(first: 5) { nodes { id body state } } } } }`: `COMMENTED`, the summary, and the Drafts' IDs now `SUBMITTED`.
- **No Drafts (`review-no-drafts`).** Open Finish Review, type a summary alone and submit: a `COMMENTED` Review with no comments.
- **Stale and Flagged (`review-stale`).** Add a Draft on line 2 and one on line 4, `click --role button --name Reload` to load them, then push a commit changing line 2 from a temporary clone. Submit: `wait --text "The pull request has new commits"`; nothing is published and both Drafts stay `PENDING`. Click the alert's Reload (the header has one too; `click` takes the first, so press the alert's over raw CDP): the head moves, the alert clears, the summary stays, and line 2's Draft is listed under Flagged drafts. Submit again: line 2's comment publishes `outdated` on the commit it was written against, line 4's on the new head.
- **Proof.** Screenshots of each state and the `gh api` answers. Delete the published comments afterwards with `deletePullRequestReviewComment`.

## Gotchas

- Published Reviews can't be deleted, only their comments; the timeline keeps showing each summary.
- Approve and Request changes can't be driven on the probe PRs, which `k-dang` authored; they need a PR by someone else.
- Right after clicking Submit Review the button keeps a hover style that looks disabled; check `disabled` over raw CDP before calling it a finding.
