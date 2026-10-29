# Activity log

The Activity icon in the rail opens the Activity log: everything the signed-in user did in Glass, newest first, under Today, Yesterday, then dated headings. Each read-only row names what happened, what it was done to, and the time. PR rows read Opened, Viewed with the file path, Approved, Requested changes, or Reviewed with any Drafts counted, or Replied, then the PR title and owner/repo#number; a Review summary or Reply body shows beneath it, clipped to two lines. To-do rows read Added to-do or Marked done, then the to-do's title. The newest 100 load on entering, with Load more for the next 100 while older Activity exists, and Refresh above the list reloads. With nothing logged it reads "No Activity yet"; a failed load shows "Couldn't read your Activity log" with Retry.

## Sub-features

- `activity-list` lists logged Activity by day, newest first, for the current Connection only.
- `activity-to-dos` lists adding a to-do and each time one is marked done.
- `activity-more` loads older Activity with Load more.

## How to get to it (user POV)

- Choose Activity in the left icon rail.
- Open a PR, view a file in Changes, submit a Review, send a Reply, or add or finish a to-do first to have something to list.

## Driving it with glass-verify

- **List (`activity-list`).** `node $V launch`, choose Activity, and `wait --text "No Activity yet"`. Choose Reviews, `type --role textbox --name "Open a PR" --text "k-dang/glass-api-probe#3"`, choose Open, then the Changes tab and `click --role treeitem --name long.txt`. Wait about three seconds with a `wait` for text that never appears and a `--timeout 3500`, then choose Activity and `wait --text "Viewed"`. The snapshot has `region "Today"` with read-only list items showing "Viewed long.txt Drafts probe k-dang/glass-api-probe#3 …" above "Opened Drafts probe …". Capture both states.
- **To-dos (`activity-to-dos`).** `node $V launch --github fake`. Add "Write the release notes" in To-dos as in [`to-dos.md`](to-dos.md), tick its checkbox, and `wait --text "Done (1)"`. Choose Activity and `wait --text "Marked done"`: `region "Today"` lists "Marked done Write the release notes …" above "Added to-do Write the release notes …".
- **Load more (`activity-more`).** Needs more than 100 logged Activities for the Connection; the renderer test covers it. Report it unreached otherwise.

## Gotchas

- Opening a PR needs real GitHub, so a `--github fake` run can only show to-do Activity.
- To-do Activity is logged under the signed-in Connection; with no Connection it isn't logged.
- A file counts as viewed after staying on screen for two seconds; leaving Changes sooner records nothing.
- The log is per run: each run has its own home, so earlier runs' Activity doesn't show.
- The list loads on entering Activity and on Refresh, not while it stays open.
