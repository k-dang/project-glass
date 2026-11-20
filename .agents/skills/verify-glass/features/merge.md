# Merge

An open PR's header shows one Merge button, left of Finish Review, when the user can write to its repository. It acts in one click with the user's default merge method, and its label and tooltip say what GitHub will do now: "Merge" merges now; "Merge when ready" turns on auto-merge while required Checks or Reviews are outstanding; "Add to merge queue" adds the PR to its base branch's merge queue. On success the button disappears, a toast names what happened, and the workspace reloads: a merged PR shows the Merged badge, and an "Auto-merge on" or "In merge queue" chip shows otherwise. If GitHub refuses, an error toast gives GitHub's reason and the button stays; if the PR has new commits, the toast offers Reload. A PR whose branch is out of date with a base that requires up-to-date branches shows a "Behind <base>" chip in place of "No conflicts".

## Sub-features

- `merge-now` merges with the default method and shows the PR merged.
- `merge-when-ready` turns on auto-merge and shows "Auto-merge on".
- `merge-queue` adds the PR to the merge queue and shows "In merge queue".
- `merge-queue-when-ready` turns on auto-merge through the queue and shows "Auto-merge on".

## How to get to it (user POV)

- Open a PR (see [PR workspace](./pr-workspace.md)) and choose Merge in its header.

## Driving it with glass-verify

Fake GitHub only (`node $V launch`); never merge on real GitHub. Open each PR with ⌘L (`press --key l --meta`, `type --role textbox --name "Open a PR" --text "octo-org/glass#<n>"`, `press --key Enter`).

- **`merge-now`:** #97. `click --role button --name Merge`, `wait --text "Merged"`: the Merged badge, no `button "Merge"`.
- **`merge-when-ready`:** #99. `click --role button --name "Merge when ready"`, `wait --text "Auto-merge on"`: the chip shows and the button is gone.
- **`merge-queue`:** #100. `click --role button --name "Add to merge queue"`, `wait --text "In merge queue"`.
- **`merge-queue-when-ready`:** #98. `click --role button --name "Merge when ready"`, `wait --text "Auto-merge on"`.
- **Proof.** A snapshot and screenshot of each header before and after.

## Gotchas

- Merging is permanent for the run's fake: relaunch to merge #97 again.
- After a PR merges, Reviews reopens it as the Saved place; switch PRs with ⌘L.
