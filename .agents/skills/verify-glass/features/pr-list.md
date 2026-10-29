# PR list

Reviews has Needs review, My PRs, and Reviewing tabs, starting on Needs review. My PRs includes the user's open PRs, including draft PRs; Reviewing helps resume other authors' open, non-draft PRs opened or worked on in Glass, or with private Drafts or a submitted Review on GitHub. Touched PRs can also appear in Needs review while a request is outstanding. Needs review shows open PRs by other authors, not marked as draft, with an outstanding Review request to the user or one of their teams, from the followed repositories. PRs from every repository form one list sorted by most recent GitHub activity, under Today, Yesterday, Past week, and Older headings. Choosing By repository instead shows one section per repository with its rows newest first, and a Not refreshed marker in its heading when they're out of date (its rows are dimmed but not marked); the choice stays in the address with the tab. A "Pull requests" header above the tabs holds the box that opens a PR, the Recent / By repository toggle, and Refresh. Each row is one line: a checks icon (Passing, Failing, Running, or Unavailable, named on hover and to screen readers), the title, Draft PR when drafted, the repository, number, author, and how long ago GitHub last saw activity. The repository, number, and author line up as columns down the whole list, and the title is what truncates when space runs out, in full on hover. A repository shows by name alone unless another listed repository shares that name, when it shows as owner/repo. Every qualifying PR is listed; there is no paging. With no followed repositories the list says so and links to Settings; with followed repositories but no requests it reads "No PRs need your review"; a failed load shows an alert with Retry. Choosing a row opens the PR workspace. `Back to PRs` closes it and returns to the list the PR was opened from: it first saves pending Drafts, then asks before discarding Drafts that couldn't save, an unsubmitted Review summary, or unpublished Replies; canceling keeps the workspace. Drafts saved to GitHub come back when the PR is opened again. A failed open shows its alert in place of the PR, with Back to PRs and Try again. The header box opens a full PR URL or owner/repo#number; anything else leaves Open disabled. All three lists come from one copy of each followed repository's open PRs, so switching tabs shows rows at once without asking GitHub. The lists refresh on entering Reviews, on window focus, every 30 seconds while visible, and from Refresh; a refresh asks GitHub only for what changed since the last one, plus the checks of listed PRs, and every 10 minutes reads every open PR again. Only Refresh spins its icon; the other refreshes happen quietly behind the rows. The lists survive restarts, so after a relaunch they show at once while Glass catches up with GitHub. Once a list has loaded, problems show where the data is rather than as alerts, while other repositories stay current. A repository that fails keeps its last rows listed, each dimmed with a Not refreshed marker giving the reason on hover; one with no rows to keep shows a dashed placeholder row reading "Couldn't load" and the repository, the reason, and Retry. When the whole refresh fails, every listed row is marked Not refreshed and "Not refreshed", with the reason on hover, shows beside the Pull requests title; Refresh retries.

## Sub-features

- `list-needs-review` shows requested PRs from every followed repository in one list under recency headings, with row details.
- `list-empty` distinguishes no followed repositories from no PRs needing review, and a load failure from both.
- `list-tabs` switches between all three lists and marks the user's draft PRs.
- `list-resume` returns to PRs opened in Glass, including those still requesting review.
- `list-open-url` opens a PR by URL or owner/repo#number and leaves Open disabled for anything else.
- `list-arrange` switches between Recent and By repository, and Back to PRs keeps the choice.
- `list-refresh` keeps healthy repositories current while a failing one shows Not refreshed rows, or a placeholder row with Retry.
- `list-saved` shows the last rows after a relaunch, before GitHub answers.
- `list-open-back` opens a row and returns with Back to PRs; reopening the row shows its GitHub-saved Drafts.
- `list-discard` asks before Back to PRs discards unsaved feedback, and canceling keeps the workspace.

## How to get to it (user POV)

- Follow repositories in Settings, then choose Reviews in the icon rail.
- Choose a PR row; in the workspace, choose `Back to PRs`.

## Driving it with glass-verify

Preconditions:

- For `list-empty` and `list-needs-review`, a fake-GitHub run (`node $V launch --github fake`): it answers four Needs review PRs, two My PRs (one a draft), and one Reviewing PR, so follow `octo-org/glass`, `octo-org/busy` (134 Needs review PRs plus the other lists), and `octo-org/quiet` (none, so hidden). `fake-github 500` then Retry shows the load-failure alert.
- For `list-open-back` and `list-discard`, a real-GitHub run (`node $V launch`), since the fake can't open a PR. Rows there need someone to have requested your review; without one, open a PR by URL above the list instead. Never request reviews on repositories you don't own for this.

- **Empty (`list-empty`).** On a fresh launch, `wait --text "No followed repositories"` and snapshot; the `Follow repositories` link opens Settings. Follow only `octo-org/quiet`, return to Reviews, and `wait --text "No PRs need your review"`.
- **Tabs (`list-tabs`).** Choose My PRs and confirm two rows, one marked Draft PR. Choose Reviewing and confirm one row. `fake-github.log` gains no GraphQL request for either switch.
- **List (`list-needs-review`).** Snapshot the `Needs review` tabpanel: rows from `glass` and `busy` interleave newest first under `Today`, `Yesterday`, and `Past week` regions, each row naming its repository (`glass`, `busy`) in an aligned column, and all 134 `busy` rows are listed.
- **Arrange (`list-arrange`).** Choose `By repository`: `octo-org/busy` and `octo-org/glass` regions each list their own rows. Open a row and choose `Back to PRs`: `By repository` is still pressed. Choose `Recent` before the next step.
- **Open by URL (`list-open-url`).** Type `#1`, then `busy#1`, into `Open a PR`: Open stays disabled. On a fake-GitHub run, `octo-org/glass#100` or its full PR URL and Enter opens the workspace with a one-file diff; a listed row opens the same workspace.
- **Refresh (`list-refresh`).** Follow `octo-org/glass` and `octo-org/busy`. Run `fake-github busy-500` and choose Refresh: `busy` rows stay listed, each dimmed and marked Not refreshed, and `glass` rows don't; My PRs shows the same for `busy`. Run `fake-github 500` and choose Refresh: "Not refreshed" shows beside the title. Run `fake-github ok` and choose Refresh: every Not refreshed marker goes. To check the placeholder row, switch to `busy-500` before following `octo-org/busy` in a fresh run, then return to Reviews: `busy` shows "Couldn't load" and Retry.
- **Saved (`list-saved`).** With rows listed, run `fake-github down`, then reach and choose `Relaunch Glass` as in [`app-lifecycle.md`](app-lifecycle.md)'s crash-and-relaunch recipe (a single `kill-backend` only restarts the backend, and the window keeps its rows). The same rows show again, each marked Not refreshed with "Not refreshed" beside the title, whose hover reads "Couldn't reach GitHub", which proves they came from the saved file. A relaunch is the only way to keep the run's home; a new `launch` starts with nothing saved.
- **Open and back (`list-open-back`, `list-discard`).** Click a row and choose `Back to PRs`: the list shows with no confirmation. Click the row again, open Finish Review, type a Review summary, and choose `Back to PRs`: the `Discard unpublished feedback?` dialog focuses Cancel. Choose Cancel and Finish Review still holds the editable summary; choose `Back to PRs` again, then Discard feedback, and the list shows.
- **Resume (`list-resume`).** In a real-GitHub run, open another author's open, non-draft PR from a followed repository. Choose `Back to PRs`, then Reviewing: the PR appears without adding feedback. If it has an outstanding request, confirm it also appears in Needs review.
- **Proof.** Snapshots and screenshots of each state.

## Gotchas

- Catching up uses GitHub search, whose index can trail a change by up to a minute; a removed review request or a Draft started on github.com may not show until the next full read, up to 10 minutes later.
- The fake's PRs are all at least an hour old, so after the first full read every refresh finds nothing changed; drive `fake-github` modes rather than expecting rows to move.
- Drive Refresh rather than waiting for the 30-second poll.
