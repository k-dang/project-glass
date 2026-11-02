# App navigation

The icon rail opens Reviews, To-dos, Activity, Dashboard, Agents, and Settings directly beside it. Each area has one title inside its page; an open PR uses the PR's title. The empty strip across the top is for dragging the window. Rail links have accessible names and titles, and the active link has `aria-current="page"`. Routes use `#/reviews` (the PR list, with `?list=` and `?view=`), `#/reviews/<owner>/<repo>/<number>` (an open PR), `#/to-dos`, `#/activity`, `#/dashboard`, `#/agents`, and `#/settings`; browser Back and Forward follow navigation, and leaving an open PR for the list asks first, as Back to PRs does. While another area shows, Reviews keeps its open PR workspace and unfinished feedback, and the Reviews link returns to that PR on its tab and file. Dashboard shows one Continue card per area with a Saved place. Agents opens its composer and Agent list; Settings shows the real GitHub connection and offers Try again after a connection failure.

## Sub-features

- `nav-areas` changes the main content and active icon with the route.
- `nav-history` restores app areas through Back, Forward, and reload.
- `nav-preserve-review` keeps the PR workspace, its tab and file, and unfinished feedback across area changes.
- `nav-connection` shows the connection in Settings and updates it after Try again.
- `nav-continue` returns to the Saved place from Dashboard after visiting another area or restarting Glass.

## How to get to it (user POV)

- Choose Reviews, To-dos, Activity, Dashboard, Agents, or Settings in the left icon rail.
- In Reviews, open a PR and select a tab or changed file before leaving and returning.

## Driving it with glass-verify

- **Areas (`nav-areas`).** Launch with `--github fake`, run doctor, and snapshot. `click --role link --name Agents`, then `wait --text "What should we work on?"`. Choose Settings and wait for `GitHub connection`; its identity is `@octocat` and token source is `GH_TOKEN`. Capture each area.
- **History (`nav-history`).** After visiting Agents and Settings, use raw CDP `Page.getNavigationHistory` and `Page.navigateToHistoryEntry` to go back and forward. Inspect `location.hash` and the active rail link. Reload Settings and confirm it opens there.
- **Preservation (`nav-preserve-review`).** Launch `--backend fake`. In Reviews, `type --role textbox --name "Open a PR" --text "https://github.com/octo-org/hello-world/pull/1"`, `click --role button --name Open`, `wait --text Reload`, then `click --role tab --name Changes` and `click --role treeitem --name default.json`. Visit Settings and Activity, then Reviews: Changes and the selected file return. Capture before and after. Finish Review's unsent summary can also be checked across area changes without choosing a submit action.
- **Connection failure (`nav-connection`).** Launch with `--github fake --fake-mode 401`, open Settings, capture its alert, set `fake-github ok`, and choose Try again. Wait for `@octocat`, then capture the updated connection.
- **Continue (`nav-continue`).** In the same fake-backend run, open Agents and snapshot. Choose the generated Agent link under Local, then `wait --text README`. Visit Settings and Activity, then Dashboard. Snapshot and screenshot `both-places`: links `Continue octo-org/hello-world#1` and `Continue <Agent name>` both appear, PR first. Choose the PR Continue link: Changes and default.json return. Choose Dashboard, then the Agent Continue link: its transcript returns. Reload Dashboard through raw CDP `Page.reload`, wait for `Continue where you left off`, then repeat both links. Neither Settings nor Activity replaces either Saved place.
- **Continue a Tour (`nav-continue`).** Use a saved Tour with multiple files. Select a later file in a later Chapter when available, visit Dashboard, and reload. Choose Continue and capture the restored Chapter and selected file after the Tour loads. Scrolling there should keep that file selected rather than return to the beginning. The focused renderer test holds the Tour response until after the workspace mounts to exercise delayed loading.

## Gotchas

- The Saved place restores the last work destination's tab, file, and reading order across reloads and restarts. Each area remembers its own Saved place: the last PR and the last Agent. Dashboard, Settings, Activity, and the PR list leave them unchanged. Unsaved feedback is still held in memory.
- Returning from another area rebuilds the workspace view: diff scroll, collapsed files, and the split or unified choice start over.
- The URL field belongs to Reviews. Every area shares the empty window drag strip.
- Use `--backend fake` for the seeded demo Agent when demonstrating both Continue cards.
