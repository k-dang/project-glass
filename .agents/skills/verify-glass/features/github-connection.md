# GitHub connection

When Glass opens, the avatar at the bottom of the app icon rail carries a status dot (pulsing while connecting, green when connected, red when not) and, on hover, reads "Connecting to GitHub…", then either "@login · via <source>" or "Not connected to GitHub". A problem replaces the Reviews area with a centered alert: a title, a detail line, a copyable `gh auth login` when signing in with the GitHub CLI would fix it, and a Try again button that re-checks without restarting and reads "Checking…" while it does.

## Sub-features

- `conn-gh` signs in from the GitHub CLI login ("via the GitHub CLI").
- `conn-env` signs in from `GH_TOKEN` or `GITHUB_TOKEN` ("via GH_TOKEN" / "via GITHUB_TOKEN"); `GH_TOKEN` wins when both are set.
- `conn-none` shows "No GitHub credentials found" when there is no token anywhere.
- `conn-rejected` shows "GitHub rejected your token" when GitHub answers 401.
- `conn-unavailable` shows "Couldn't reach GitHub" with the reason on a non-200 answer or a failed connection.
- `conn-retry` re-checks on Try again and moves to whatever GitHub now answers.

## How to get to it (user POV)

- Open Glass; the status loads by itself. Hover the rail avatar to read it.
- Choose `Try again` on the problem alert.

## Driving it with glass-verify

Preconditions:

- A fresh run in the GitHub mode each step names; `node $V doctor` passes.
- For `conn-gh`, `gh auth status` succeeds and neither `GH_TOKEN` nor `GITHUB_TOKEN` is set in your shell.

- **Real sign-in (`conn-gh`/`conn-env`).** `node $V launch`, then `node $V snapshot connected-real`. The rail avatar is `status "@<login> · via <source>"`, with `@<login>` matching `gh api user --jq .login`, followed by the source label for whichever credential your shell provides.
- **No credentials (`conn-none`).** `node $V launch --no-build --no-credentials`, then `node $V wait --text "No GitHub credentials found"`. The `alert` contains the detail "Run `gh auth login`, then try again. Glass reads GH_TOKEN and GITHUB_TOKEN only when it starts, so relaunch after setting one.", `button "Copy gh auth login"`, and `button "Try again"`.
- **Rejected token (`conn-rejected`).** `node $V launch --no-build --github fake --fake-mode 401`, then `node $V wait --text "GitHub rejected your token"`. Detail reads "The token from GH_TOKEN is invalid or expired. Replace it, then relaunch Glass.", with no copy button.
- **GitHub error (`conn-unavailable`).** `--fake-mode 500` shows "Couldn't reach GitHub" / "GitHub had a problem answering (HTTP 500). Try again in a moment.". `node $V fake-github down` then Try again shows "Check your internet connection, then try again.", and after `stop`, `evidence/backend.log` has a `GitHub request failed` warning with the technical cause. The detail never shows raw transport errors or URLs.
- **Retry (`conn-retry`).** From the rejected state: `node $V snapshot rejected`, `node $V screenshot rejected`, `node $V fake-github ok`, `node $V click --role button --name "Try again"`, `node $V snapshot connected`, `node $V screenshot connected`. The rail avatar is `status "@octocat · via GH_TOKEN"` with a green dot, and the alert is gone.
- **Proof.** After `node $V stop`, `evidence/fake-github.log` has one `GET /user -> <mode>` line per check, in order (e.g. `-> 401` then `-> ok`), alongside the before/after snapshots and screenshots.

## Gotchas

- The status checks once at startup. To see a different starting state, launch a new run; to see a change mid-run, use Try again.
- The status lives only in the avatar's accessible name and tooltip, so `wait --text` can't see it; assert on the `status` in a snapshot, and snapshot again if it still reads "Connecting to GitHub…".
- A real-GitHub run uses whatever credential your shell has. Unset `GH_TOKEN`/`GITHUB_TOKEN` to prove the `gh` path, and say which source the proof used.
- With `--github fake` the source label is always `GH_TOKEN` (the dummy token); `GITHUB_TOKEN` precedence needs a real run with only that variable set.
- `--no-credentials` combined with `--github fake` still has no token, so the fake is never called.
