# Tours

A Tour orders a PR's changed files into Chapters with explanations and file summaries. The user chooses a Tour engine in Settings, writes the Tour, and starts reading its Chapters in Changes.

## Sub-features

- `tour-write` writes and saves a Tour for the open Revision.
- `tour-read` opens the saved Tour and shows its Chapter and file summaries alongside the changed files.
- `tour-queue` writes a Tour in the background for a PR added to the Queue, once Tours for the Queue are on in Settings, with the Tour engine, and shows its status on the Queue row.

## How to get to it (user POV)

In Settings → Tours, choose pi as the Tour engine and Save changes. Open a PR, select the Tour tab, then Write Tour. When the Tour is saved, choose Start reading.

## Driving it with glass-verify

1. Launch `node $V launch` and run `node $V doctor`. This defaults to real GitHub for PR reads and a local synthetic provider for Tour generation.
2. Open Settings, `node $V click --role radio --name "pi"`, then `node $V click --role button --name "Save changes"` and `node $V wait --text "Settings saved."`.
3. Open a readable PR following [PR workspace](pr-workspace.md). A small example is `https://github.com/k-dang/glass-api-probe/pull/1`. `node $V click --role tab --name "Tour"`, then capture a snapshot and screenshot before writing.
4. `node $V click --role button --name "Write Tour"`, then `node $V wait --text "Development Tour"`. Capture a snapshot and screenshot of the saved Tour.
5. `node $V click --role button --name "Start reading"`. Capture the Chapter and its `Synthetic file summary.` entries in Changes. Confirm its file paths match the PR's changed files.
6. For `tour-queue`, open Settings and `node $V click --role switch --name "Tours for the Queue"`. Go back to Reviews, select the Queue tab, and `node $V type --role textbox --name "Add to the Queue" --text "<another PR URL>"`. Then `node $V wait --text "Tour ready"` and capture the row.
7. Stop the run. `evidence/fake-pi.log` records a completion and the changed-file count; the backend port closes and the fake provider stops.

## Gotchas

- Fake output is marked synthetic and adapts only the file paths; it does not analyze the PR. This verifies the app and the pi CLI path, saving, and reading, without validating real authentication or model quality.
- Fake mode disables Claude Code; choose pi as the Tour engine to write the Tour. Your normal Pi credentials and settings are untouched.
- The Tour engine starts as Claude Code. In fake mode, choose pi before writing or queueing, or Tours fail with Claude Code unavailable.
- With `--github fake`, open a seeded PR such as `https://github.com/glass-demo/greeter/pull/100`; the shared fake supports its workspace, diff, and Tour input.
- For live-provider verification, launch with `--tour-provider real` and your configured credentials. That can incur charges; expect provider-generated text instead of the synthetic markers above.
