# Tours

A Tour orders a PR's changed files into Chapters with explanations and file summaries, reading a checkout of the PR. The user writes the Tour and starts reading at its Tour overview in Changes, when it has a diagram, Before / after, or review Hotspots, or at its first Chapter.

## Sub-features

- `tour-write` writes and saves a Tour for the open Revision.
- `tour-read` opens the saved Tour and shows its Tour overview, then each Chapter and its file summaries alongside the changed files.
- `tour-map` shows one overview diagram or outline. Diagram nodes identify their Chapters and open the corresponding diff lines, including the old side and viewed Chapters. Narrow windows scroll wide maps inside their own region.
- `tour-queue` writes a Tour in the background for a PR added to the Queue, once Tours for the Queue are on in Settings, and shows its status on the Queue row.

## How to get to it (user POV)

Open a PR, select the Tour tab, then Write Tour. When the Tour is saved, choose Start reading.

## Driving it with glass-verify

1. Launch `node $V launch --backend fake` and run `node $V doctor`. This uses the shared demo PRs, a fake git remote for the checkout, and synthetic Tour runners, without model charges.
2. In Reviews, type `https://github.com/octo-org/hello-world/pull/1` into the Open a PR textbox, choose Open, and `wait --text "Rate-limit the public API"`. `node $V click --role tab --name "Tour"`, then capture a snapshot and screenshot before writing.
3. `node $V click --role button --name "Write Tour"`, then `node $V wait --text "curated synthetic Tour"`. Capture a snapshot and screenshot of the saved Tour.
4. `node $V click --role button --name "Start reading"`, then `node $V wait --text "What happens to a request"`. Capture the Tour overview: the intent beside the Before / after, above the first Chapter.
5. Click a changed line, such as `node $V click --role button --name "no token left: return 429 with retry-after, added. Show middleware.ts:28"`. Capture its Chapter with the target line selected.
6. For `tour-queue`, open Settings and `node $V click --role switch --name "Tours for the Queue"`. Go back to Reviews, select the Queue tab, and `node $V type --role textbox --name "Add to the Queue" --text "<another PR URL>"` and `node $V press --key Enter`. Then `node $V wait --text "Tour ready"` and capture the row.
7. For `tour-map`, return to Reviews and open `https://github.com/octo-org/hello-world/pull/8`, the OpenCode example. Write its Tour and Start reading. Capture the overview with its labeled branches and Chapter references. Click `OpenCode service, Added. Show openCodeRuntime.ts, new lines 5`; capture Chapter 02 with the service call selected. Return to the overview with `[` twice and click `Claude Code, Unchanged. Show HostConversations.ts, old lines 3`; capture the selected old line in Chapter 01. Mark Chapter 02 viewed and repeat its node click to verify it reopens without changing viewed progress. The validation example is PR 9; the settings outline is PR 10.
8. Stop the run. The backend port closes.

## Gotchas

- Tours fetch a checkout, so use `--backend fake`: plain `launch` has Claude Code and pi off, and its fake GitHub has no git remote. To exercise a real model, use `--github real --real-agents`, which can incur charges.
- Synthetic Tours don't analyze the PR. The rate-limit demo and the three Tour examples have curated visuals; other PRs get marked synthetic Chapters that adapt the file paths. This verifies the app, the checkout, saving, and reading, without validating real authentication or model quality.
- Existing saved Tours keep their content until Rewrite. Outdated Tours hide their code-linked visuals until rewritten for the current Revision.
