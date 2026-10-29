# App navigation

The icon rail opens Reviews, To-dos, Activity, Dashboard, Agents, and Settings directly beside it. Each area has one title inside its page; an open PR uses the PR's title. The empty strip across the top is for dragging the window. Rail links have accessible names and titles, and the active link has `aria-current="page"`. Routes use `#/reviews` (the PR list, with `?list=` and `?view=`), `#/reviews/<owner>/<repo>/<number>` (an open PR), `#/to-dos`, `#/activity`, `#/dashboard`, `#/agents`, and `#/settings`; browser Back and Forward follow navigation, and leaving an open PR for the list asks first, as Back to PRs does. While another area shows, Reviews keeps its open PR workspace and unfinished feedback, and the Reviews link returns to that PR on its tab and file. Dashboard shows the Saved place as a Continue card. Agents shows an unavailable message; Settings shows the real GitHub connection and offers Try again after a connection failure.

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

- **Areas (`nav-areas`).** Launch with `--github fake`, run doctor, and snapshot. `click --role link --name Agents`, then `wait --text "Agents aren't available yet."`. Choose Settings and wait for `GitHub connection`; its identity is `@glass-verify` and token source is `GH_TOKEN`. Capture each area.
- **History (`nav-history`).** After visiting Agents and Settings, use raw CDP `Page.getNavigationHistory` and `Page.navigateToHistoryEntry` to go back and forward. Inspect `location.hash` and the active rail link. Reload Settings and confirm it opens there.
- **Preservation (`nav-preserve-review`).** In a real-GitHub run, open a PR using the [PR workspace recipe](./pr-workspace.md), open Finish Review and type a Review summary without submitting, then visit Agents and Settings. Return to Reviews: the PR remains, and Finish Review still holds the summary. Select a changed file in Changes, switch areas again, and confirm the tab and selected file remain. This check reads GitHub and leaves feedback unpublished.
- **Connection failure (`nav-connection`).** Launch with `--github fake --fake-mode 401`, open Settings, capture its alert, set `fake-github ok`, and choose Try again. Wait for `@glass-verify`, then capture the updated connection.
- **Continue (`nav-continue`).** Open Dashboard before opening any PR and capture its empty state. Open a PR, choose Changes and a file, then visit Settings and Activity; neither page shows Continue. Choose Dashboard and capture its card naming the PR, tab, reading order, and file. Choose `Continue owner/repo#number` and confirm Changes and the saved file return. Repeat with a selected file in Files. Reload Dashboard, then choose Continue again: the selected tab and file return. A changed Revision opens Overview with a notice; another GitHub identity gets no Continue link for this Saved place. Capture the restored workspace. Backend persistence across launches is also covered by `SavedPlaces.test.ts`.
- **Continue a Tour (`nav-continue`).** Use a saved Tour with multiple files. Select a later file in a later Chapter when available, visit Dashboard, and reload. Choose Continue and capture the restored Chapter and selected file after the Tour loads. Scrolling there should keep that file selected rather than return to the beginning. The focused renderer test holds the Tour response until after the workspace mounts to exercise delayed loading.

## Gotchas

- The Saved place restores the last work destination's tab, file, and reading order across reloads and restarts. Only one work destination is remembered; Dashboard, Settings, Activity, the PR list, and the unavailable areas leave it unchanged. Unsaved feedback is still held in memory.
- Returning from another area rebuilds the workspace view: diff scroll, collapsed files, and the split or unified choice start over.
- The URL field belongs to Reviews. Every area shares the empty window drag strip.
- Agents has no running-agent controls yet; it is a navigation destination.
