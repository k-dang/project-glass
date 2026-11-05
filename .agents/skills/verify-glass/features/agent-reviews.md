# Agent reviews

An Agent review is private criticism of a PR Revision. Read it beside Changes or read its opening on Overview; publishing a Review is a separate action.

## Sub-features

- Write an Agent review, read it beside the diff, and find its opening on Overview.
- Send Follow-ups about the review beside the diff: each is a Turn of the review's own Agent, which reads a checkout of the Revision and stays out of the Agents list.

## How to get to it (user POV)

Open a PR, choose Changes, then Agent review and, once written, Read Agent review.

## Driving it with glass-verify

1. `node $V launch --backend fake`, then doctor and snapshot. This uses the shared demo PRs and synthetic Agent runners, without model charges.
2. `type --role textbox --name "Open a PR" --text "https://github.com/octo-org/hello-world/pull/1"`, `click --role button --name Open`, `wait --text Reload`, then `click --role tab --name Changes`.
3. Snapshot and screenshot `review-before`. `click --role button --name "Agent review"`, `wait --text "Read Agent review"`, then `click --role button --name "Read Agent review"`.
4. `wait --text "Synthetic point on middleware.ts"`. Snapshot and screenshot `review-beside`: the Agent review tab and full synthetic Markdown appear beside the diff.
5. `type --role textbox --name "Follow up" --text "Is the first point blocking?"`, `click --role button --name Send`, then `wait --text "Done in" --timeout 40000`. Screenshot `review-follow-up`: the message and the demo pi Agent's Turn under the review. The demo model asks for `bash`, which the review's Agent doesn't have, so no tool call runs.
6. Send a second Follow-up the same way and wait for its reply (`Got it: …`). Both Turns sit under the review, and `.verify/<id>/state/home/.project-glass/agent-review-checkouts/` holds one checkout. Open the Agents rail: the review's Agent isn't listed.
7. `click --role tab --name Overview`. Snapshot and screenshot `review-overview`: its Agent review card shows the opening, without the full points. Stop the run.

## Gotchas

- This follows `apps/desktop/e2e/agentReview.spec.ts` with shared demo data. Synthetic output proves UI and persistence, not model quality or live authentication.
- The demo model can't call `suggest_draft`, so adding a Suggested draft isn't drivable here; `AgentReviewBesideDiff.test.tsx` and the `*-review` adapter recordings cover it.
- dev:fake points Agent reviews' pi at the demo model only in a fresh `settings.json`; an older run's Settings may still name a real model, which fails to sign in.
