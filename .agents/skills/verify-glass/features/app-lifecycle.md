# App lifecycle

Opening Glass shows one "Glass" window while its backend starts; the backend's output goes to a log file; closing the window quits the app and stops the backend with it. If the backend crashes, Glass restarts it on the same port while the window shows "Reconnecting to Glass's backend…", and the window's calls work again once it is back. If the backend fails to start, or crashes four times without a minute's healthy run in between, the window shows an error screen with the log file's path and a "Relaunch Glass" button, which quits Glass and opens it again.

## Sub-features

- `life-open` opens a 1280×820 window titled "Glass" showing an app icon rail ending in the connection avatar, and a Reviews top bar with the pull request URL field.
- `life-backend` starts the backend on a fresh localhost port behind a per-launch secret while the window loads; the window reaches it once it is up.
- `life-logs` appends backend output and Glass's `[glass <time>]` start, restart, and give-up notes to `~/.glass/logs/backend.log` across launches, moving it to `backend.previous.log` at launch once it passes 5 MB.
- `life-quit` closing the last window quits Glass and frees the backend's port.
- `life-start-error` fills the window with "Glass's backend didn't start" when the backend fails to start four times in a row.
- `life-restart` restarts a backend that exits after starting, on the same port and token, while a "Reconnecting to Glass's backend…" banner shows above the page.
- `life-crash` fills the window with "Glass's backend keeps stopping" once restarts run out.
- `life-relaunch` "Relaunch Glass" quits and reopens Glass, whose new backend runs on a new port.

## How to get to it (user POV)

- Launch Glass (`pnpm start`, or the packaged app).
- Close the window.
- A failed start or a crash happens on its own; a crash usually heals, and only repeated ones end at "Relaunch Glass".

## Driving it with glass-verify

Preconditions:

- No live run with the same ID (`node $V list`).

- **Open (`life-open`, `life-backend`).** `node $V launch`, then `node $V doctor`. Every line is `OK`, including "Window shows the built renderer" and "Backend health". `node $V snapshot opened` shows `navigation "App areas"`, links for Reviews, Agents, and Settings, `textbox "Pull request URL"`, and `heading "Open a pull request"`.
- **Logs (`life-logs`).** The run's `GLASS_HOME` is `.verify/<id>/state/home`, so the log is `.verify/<id>/state/home/.glass/logs/backend.log` and contains `[glass <time>] Starting backend` followed by `Listening on http://127.0.0.1:<port>` matching the backend URL `launch` printed. Rotation to `backend.previous.log` needs 5 MB of output; the main-process test covers it.
- **Quit (`life-quit`).** `node $V stop`. It requests app shutdown and prints `Backend port <port>: closed`. "Electron did not quit; killing its process tree" means the app did not quit by itself, which is a failure.
- **Start error (`life-start-error`).** `node $V launch --github fake --fail-backend-start`. `node $V wait --text "didn't start"`, then `snapshot`/`screenshot`: `heading "Glass's backend didn't start"`, the log path, and `button "Relaunch Glass"`. `backend.log` shows four `Starting backend` notes, restarts after 500ms, 1s, and 2s, and `giving up`. A relaunch fails the same way in this mode.
- **Restart (`life-restart`).** `node $V launch --github fake`, `wait --text "Needs review"`, then `node $V kill-backend` and at once `wait --text "Reconnecting"` and capture `reconnecting`. The banner clears within about 2s; `doctor` then shows the same Electron pid and "Backend health" OK on the same port. Add a to-do to prove calls work again, and `backend.log` shows `Backend exited with code 1; restarting in 500ms`.
- **Crash and relaunch (`life-crash`, `life-relaunch`).** Run `kill-backend` four times, each once the Reconnecting banner has cleared. `wait --text "keeps stopping"` and capture `heading "Glass's backend keeps stopping"`. `click --role button --name "Relaunch Glass"`, `wait --text "Needs review"`, then `doctor`: "Electron process" shows a new pid and "Backend health" is OK on a new port. `backend.log` still holds the earlier launch's restarts and `giving up`, followed by the new port's `Listening on` line. `stop` then reports that new port closed.
- **Proof.** `evidence/backend.log` and `evidence/electron.log` survive `stop`, with the `Listening on` line, alongside `opened.aria.txt`.

## Gotchas

- `launch` waits up to 60s for the backend before reporting Ready, and stops early with the failure if the window reports one; read `.verify/<id>/state/electron.log` and the backend log before running `stop`.
- While Glass relaunches there is briefly no window. `wait` keeps looking for the new one; other commands fail until it is back, so `wait` first. `stop` follows a relaunch in progress to the new window.
- `doctor` fails "Backend health" while the error screen shows; that is expected there.
- The window's avatar names `@glass-verify` only in its accessible name; wait for page text such as "Needs review" instead.
- `kill-backend` fails with "nothing is listening" while a restart is in progress; retry it once the banner clears.
- The helper sets `GLASS_HOME` per run so it never touches the user's real `~/.glass/logs` or `~/.project-glass`. `HOME` stays the user's, so `gh` still finds their login.
