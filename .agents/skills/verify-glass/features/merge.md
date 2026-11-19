# Merge

An open PR's header shows Merge, left of Finish Review, when the user can write to its repository. It opens a popover offering what GitHub would do now. "Merge pull request" offers the repository's allowed methods as radios, the user's default first, and the submit button is named for the picked method ("Squash and merge"). "Merge when ready" offers the same radios while required Checks or Reviews are outstanding and turns on auto-merge. With a merge queue, "Add to merge queue" (ready now) or "Add to merge queue when ready" (waiting) offers no methods. On success the popover closes, a toast names what happened, and the workspace reloads: a merged PR shows the Merged badge and no Merge button, and an "Auto-merge on" or "In merge queue" chip replaces Merge otherwise. If GitHub refuses, the popover stays open with GitHub's reason; if the PR has new commits, it says so and offers Reload.

## Sub-features

- `merge-now` merges with a picked method and shows the PR merged.
- `merge-when-ready` turns on auto-merge and shows "Auto-merge on".
- `merge-queue` adds the PR to the merge queue and shows "In merge queue".
- `merge-queue-when-ready` turns on auto-merge through the queue and shows "Auto-merge on".

## How to get to it (user POV)

- Open a PR (see [PR workspace](./pr-workspace.md)) and choose Merge in its header.

## Driving it with glass-verify

Fake GitHub only (`node $V launch`); never merge on real GitHub. Follow `octo-org/glass`, then open each PR with ⌘L (`press --key l --meta`, `type --role textbox --name "Open a PR" --text "octo-org/glass#<n>"`, `press --key Enter`).

- **`merge-now`:** #97. `click --role button --name Merge`, `wait --text "Merge pull request"`: `radiogroup "Merge method"` with "Create a merge commit", "Squash and merge", "Rebase and merge". `click --role radio --name "Rebase and merge"`, `click --role button --name "Rebase and merge"`, `wait --text "Merged"`: the Merged badge, no `button "Merge"`.
- **`merge-when-ready`:** #99. Merge opens "Merge when ready" with the method radios; `click --role button --name "Merge when ready"`, `wait --text "Auto-merge on"`: the chip shows and Merge is gone.
- **`merge-queue`:** #100. Merge opens "Add to merge queue" with no radios; submit it and `wait --text "In merge queue"`.
- **`merge-queue-when-ready`:** #98. Merge opens "Add to merge queue when ready" with no radios; submit it and `wait --text "Auto-merge on"`.
- **Proof.** A snapshot and screenshot of each open popover and each result.

## Gotchas

- Merging is permanent for the run's fake: relaunch to merge #97 again.
- After a PR merges, Reviews reopens it as the Saved place; switch PRs with ⌘L.
