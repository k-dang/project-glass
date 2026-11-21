# Agent reviews

An Agent review is private criticism of a PR Revision. Read it beside Changes or read its opening on Overview; publishing a Review is a separate action.

## Sub-features

- Write an Agent review, read it beside the diff, and find its opening and Hotspots on Overview.
- See the Agent review's Hotspots in a Tour of the same Revision, each linking back to the review.
- Send Follow-ups about the review beside the diff: each is a Turn of the review's own Thread, which reads a checkout of the Revision and stays out of the Threads list.

## How to get to it (user POV)

Open a PR, open Agent work in its header, then Start on the Agent review row and, once written, Read.

## Driving it with glass-verify

1. `node $V launch --backend fake`, then doctor and snapshot. This uses the shared demo PRs and synthetic Agent runners, without model charges.
2. `type --role textbox --name "Open a PR" --text "https://github.com/octo-org/hello-world/pull/1"`, `click --role button --name Open`, `wait --text "Rate-limit the public API"`, then `click --role tab --name Changes`.
3. Snapshot and screenshot `review-before`. `click --role button --name "Agent work"`. The demo backend starts this PR's Agent review as it seeds, so its row already says `Ready` (otherwise choose its `Start`; the Tour row's button says Write). `click --role button --name Read`.
4. `wait --text "Any caller can mint a fresh bucket"`. Snapshot and screenshot `review-beside`: the Agent review panel appears right of the diff with the demo's curated review, its three ranked Hotspots between the opening and the Minor list. `config/default.json`, the docs, the changelog, and `package.json` start collapsed in the diff, marked Low attention.
5. `type --role textbox --name "Follow up" --text "Is the first point blocking?"`, `click --role button --name Send`, then `wait --text "Done in" --timeout 40000`. Screenshot `review-follow-up`: the message and the demo pi Thread's Turn under the review. The demo model asks for `bash`, which the review's Thread doesn't have, so no tool call runs.
6. Send a second Follow-up the same way and wait for its reply (`Got it: …`). Both Turns sit under the review, and `.verify/<id>/state/home/.project-glass/agent-review-checkouts/` holds one checkout. Open the Threads rail: the review's Thread isn't listed.
7. `click --role tab --name Overview`. Snapshot and screenshot `review-overview`: its Agent review card shows the opening and the ranked Hotspot titles, without their detail.
8. In the Tour tab of the file panel, `click --role button --name "Write Tour"`, then `wait --text "Start reading"` and click it. Screenshot `review-tour`: the Tour overview lists the Hotspots under Where to look first, tagged with their Chapters, and the first Chapter shows its two Hotspots above its callouts. Stop the run.

## Gotchas

- This follows `apps/desktop/e2e/agentReview.test.ts` with shared demo data. Synthetic output proves UI and persistence, not model quality or live authentication.
- The demo model can't call `suggest_draft`, so adding a Suggested draft isn't drivable here; `AgentReviewBesideDiff.test.tsx` and the `*-review` adapter recordings cover it.
- dev:fake points Agent reviews' pi at the demo model only in a fresh `settings.json`; an older run's Settings may still name a real model, which fails to sign in.
