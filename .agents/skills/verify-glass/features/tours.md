# Tours

A Tour orders a PR's changed files into Chapters with explanations and file summaries, reading a checkout of the PR. The user writes the Tour and starts reading at its Tour overview in Changes, when it has a Before / after, or at its first Chapter.

## Sub-features

- `tour-write` writes and saves a Tour for the open Revision.
- `tour-read` opens the saved Tour and shows its Tour overview, then each Chapter and its file summaries alongside the changed files.
- `tour-queue` writes a Tour in the background for a PR added to the Queue, once Tours for the Queue are on in Settings, and shows its status on the Queue row.

## How to get to it (user POV)

Open a PR, select the Tour tab, then Write Tour. When the Tour is saved, choose Start reading.

## Driving it with glass-verify

1. Launch `node $V launch --backend fake` and run `node $V doctor`. This uses the shared demo PRs, a fake git remote for the checkout, and synthetic Tour runners, without model charges.
2. In Reviews, type `https://github.com/octo-org/hello-world/pull/1` into the Open a PR textbox, choose Open, and wait for Reload. `node $V click --role tab --name "Tour"`, then capture a snapshot and screenshot before writing.
3. `node $V click --role button --name "Write Tour"`, then `node $V wait --text "curated synthetic Tour"`. Capture a snapshot and screenshot of the saved Tour.
4. `node $V click --role button --name "Start reading"`, then `node $V wait --text "What happens to a request"`. Capture the Tour overview: the intent beside the Before / after, above the first Chapter.
5. Click a changed line, such as `node $V click --role button --name "no token left: return 429 with retry-after, added. Show middleware.ts:28"`. Capture its Chapter with the target line selected.
6. For `tour-queue`, open Settings and `node $V click --role switch --name "Tours for the Queue"`. Go back to Reviews, select the Queue tab, and `node $V type --role textbox --name "Add to the Queue" --text "<another PR URL>"`. Then `node $V wait --text "Tour ready"` and capture the row.
7. Stop the run. The backend port closes.

## Gotchas

- Tours fetch a checkout, so use `--backend fake`: plain `launch` has Claude Code and pi off, and its fake GitHub has no git remote. To exercise a real model, use `--github real --real-agents`, which can incur charges.
- Synthetic Tours don't analyze the PR. Only the rate-limit demo PR gets the curated Tour with a Before / after and diagram; other PRs get marked synthetic Chapters that adapt the file paths. This verifies the app, the checkout, saving, and reading, without validating real authentication or model quality.
