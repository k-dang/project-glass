# Agent reviews

An Agent review is private criticism of a PR Revision. Read it beside Changes or read its opening on Overview; publishing a Review is a separate action.

## Sub-features

- Write an Agent review, read it beside the diff, and find its opening on Overview.
- Send a Follow-up about the review beside the diff, then add its Suggested draft as a Draft.

## How to get to it (user POV)

Open a PR, choose Changes, then Agent review and Read beside the diff.

## Driving it with glass-verify

1. `node $V launch --backend fake`, then doctor and snapshot. This uses the shared demo PRs and synthetic Agent runners, without model charges.
2. `type --role textbox --name "Open a PR" --text "https://github.com/octo-org/hello-world/pull/1"`, `click --role button --name Open`, `wait --text Reload`, then `click --role tab --name Changes`.
3. Snapshot and screenshot `review-before`. `click --role button --name "Agent review"`, `wait --text "Agent review written"`, then `click --role button --name "Read beside the diff"`.
4. `wait --text "Synthetic point on middleware.ts"`. Snapshot and screenshot `review-beside`: the Agent review tab and full synthetic Markdown appear beside the diff.
5. `type --role textbox --name "Follow up" --text "Draft a comment"`, `press --key Enter`, then `wait --text "A synthetic follow-up answer"`. Screenshot `review-follow-up`: the message, the answer, and one Suggested draft on the first diff line.
6. `click --role button --name "Add Draft"`, then `wait --text "You have a Draft on this line."`. Screenshot `review-draft-added`: Finish Review and Notes each count 1 Draft.
7. `click --role tab --name Overview`. Snapshot and screenshot `review-overview`: its Agent review card shows the opening, without the full points. Stop the run.

## Gotchas

- This follows `apps/desktop/e2e/agentReview.spec.ts` with shared demo data. Synthetic output proves UI and persistence, not model quality or live authentication.
- Use `--backend fake` here: the default helper Pi fixture answers Tours, not Agent review Markdown.
