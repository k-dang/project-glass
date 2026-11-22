# Thread artifacts

An agent's files and drawings open beside its Thread. Paths the agent names in inline code or Markdown links become buttons once the Turn ends, and each opens a File pane that renders the file by type, or the Browser pane for an HTML file. Images the agent links in Markdown show inline. Diagrams the agent draws appear as cards that open a diagram pane. Images the user attached open full size.

## Sub-features

- Browser pane: an HTML page, with Feedback notes (see [page-notes](./page-notes.md)).
- File pane: Markdown rendered, an image, code or text, "Binary file not shown", and "File too large to show".
- Inline image in a reply, which opens in the File pane on click.
- Diagram cards: existing behavior, a proposed design, and a refused version ("Glass couldn't draw this version, so the last one stays."), plus a Mermaid block drawn inline in the chat.
- Attached images: a thumbnail above the user's message that opens the image viewer.

## How to get to it (user POV)

On the fake backend, the seeded pi Thread `demo/artifacts` covers every sub-feature, with no prompt to type.

## Driving it with glass-verify

1. `node $V launch --backend fake`, doctor. Open Threads, then `click --role link --name demo/artifacts`. `wait --text "proposed one stays"`. Screenshot: three diagram cards, the last refused.
2. Click each file button and wait for what only its pane shows, then screenshot:
   - `the plan`: `wait --text "pick an element"`.
   - `notes.md`: `wait --text "Give each Connection a token bucket."`.
   - `bucket.ts`: `wait --text "refillBucket"`.
   - `limits.bin`: `wait --text "Binary file not shown"`.
   - `poller.log`: `wait --text "File too large to show"`.
   - `chart.svg`, then the inline image `Requests per minute`: screenshot the chart in the File pane.
3. Click the first diagram card's `Open`. Screenshot: the Message flow pane.
4. `scroll --by=-2000 --x 800 --y 400`, click `Open attachment 1`. Screenshot: the image viewer.

## Gotchas

- `scroll --by` needs `=` before a negative number.
- The Thread writes `poller.log` as a 10 MB file in its worktree, so its Changes show it too.
