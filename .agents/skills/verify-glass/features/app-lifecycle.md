# App lifecycle

Opening Glass shows one "Glass" window while its backend starts; the backend's output goes to a log file; closing the window quits the app and stops the backend with it. If the backend crashes, Glass restarts it on the same port while the window shows "Reconnecting to Glass's backend…", and the window's calls work again once it is back. If the backend fails to start, or crashes four times without a minute's healthy run in between, the window shows an error screen with the log file's path and a "Relaunch Glass" button, which quits Glass and opens it again.

## Sub-features

- `life-open` opens a 1280×820 window titled "Glass" showing an app icon rail ending in the connection avatar, and Dashboard.
- `life-backend` starts the backend on a fresh localhost port behind a per-launch secret while the window loads; the window reaches it once it is up.
- `life-logs` appends backend output and Glass's `[glass <time>]` start, restart, and give-up notes to `~/.project-glass/backend.log` across launches, moving it to `backend.previous.log` at launch once it passes 5 MB.
- `life-quit` closing the last window quits Glass and frees the backend's port.
- `life-start-error` fills the window with "Glass's backend didn't start" when the backend fails to start four times in a row.
- `life-restart` restarts a backend that exits after starting, on the same port and token, while a "Reconnecting to Glass's backend…" banner shows above the page.
- `life-crash` fills the window with "Glass's backend keeps stopping" once restarts run out.
- `life-relaunch` "Relaunch Glass" quits and reopens Glass, whose new backend runs on a new port.
- `life-outlive` a local Thread's running Turn keeps going while Glass is closed, and its reply shows once Glass opens again.

## How to get to it (user POV)

- Launch Glass (`pnpm start`, or the packaged app).
- Close the window.
- A failed start or a crash happens on its own; a crash usually heals, and only repeated ones end at "Relaunch Glass".

## Driving it with glass-verify

Preconditions:

- No live run with the same ID (`node $V list`).

- **Open (`life-open`, `life-backend`).** `node $V launch`, then `node $V doctor`. Every line is `OK`, including "Window shows the built renderer" and "Backend health". `node $V snapshot opened` shows `navigation "App areas"` with seven links from Dashboard to Settings, `main "Dashboard"`, and `heading "Dashboard"`.
- **Logs (`life-logs`).** The run's `GLASS_HOME` is `.verify/<id>/state/home`, so the log is `.verify/<id>/state/home/.project-glass/backend.log` and holds one JSON line per note: `"message":"Starting backend"` from the desktop, then `"message":"Listening on http://127.0.0.1:<port>"` from the backend, matching the backend URL `launch` printed. Rotation to `backend.previous.log` needs 5 MB of output; the main-process test covers it.
- **Quit (`life-quit`).** `node $V stop`. It requests app shutdown and prints `Backend port <port>: closed`. "Electron did not quit; killing its process tree" means the app did not quit by itself, which is a failure.
- **Start error (`life-start-error`).** `node $V launch --github fake --fail-backend-start`. `node $V wait --text "didn't start"`, then `snapshot`/`screenshot`: `heading "Glass's backend didn't start"`, the log path, and `button "Relaunch Glass"`. `backend.log` shows four `Starting backend` notes, `Backend exited with code 1; restarting in` 500ms, 1s, and 2s, and `Backend exited with code 1; giving up`. A relaunch fails the same way in this mode.
- **Restart (`life-restart`).** `node $V launch --github fake`, `wait --text "Dashboard"`. The banner lasts only while the backend restarts, about a second and a half, so start `wait --text "Reconnecting" --timeout 20000` in a second shell before `node $V kill-backend`; a `wait` started after `kill-backend` returns usually misses it. The banner then clears; `doctor` then shows the same Electron pid and "Backend health" OK on the same port. Add a to-do to prove calls work again, and `backend.log` shows `Backend exited with code 1; restarting in 500ms`.
- **Crash and relaunch (`life-crash`, `life-relaunch`).** Run `kill-backend` four times, each once the Reconnecting banner has cleared. `wait --text "keeps stopping"` and capture `heading "Glass's backend keeps stopping"`. `click --role button --name "Relaunch Glass"`, `wait --text "Dashboard"`, then `doctor`: "Electron process" shows a new pid and "Backend health" is OK, usually on the same port: Glass reuses its last port while it is free, and only the secret is new. `backend.log` still holds the earlier launch's restarts and `giving up`, followed by a new `Listening on` line. `stop` then reports that new port closed.
- **Turn outlives the app (`life-outlive`).** Needs `--real-agents`: the fake backend's model servers stop with Glass. Link a clone, start a Claude Code Thread that runs `ping -c 60 127.0.0.1 | tail -1` in the foreground (Claude Code refuses a bare `sleep`, and a command it moves to the background ends the Turn at once), and once "Working" shows, close Glass without `stop` (CDP `Browser.close`). The backend port closes; the port in `.verify/<id>/state/home/.project-glass/agent-host.json` still answers `/healthz`. After the command ends, `node $V relaunch`: the Turn shows its reply once and "Done in …". `stop` with nothing running then ends that host process.
- **Proof.** `evidence/backend.log` and `evidence/electron.log` survive `stop`, with the `Listening on` line in the backend log, alongside `opened.aria.txt`.

## Gotchas

- `launch` waits up to 60s for the backend before reporting Ready, and stops early with the failure if the window reports one; read `.verify/<id>/state/electron.log` and the backend log before running `stop`.
- While Glass relaunches there is briefly no window. `wait` keeps looking for the new one; other commands fail until it is back, so `wait` first. `stop` follows a relaunch in progress to the new window.
- `doctor` fails "Backend health" while the error screen shows; that is expected there.
- The window's avatar names `@glass-verify` only in its accessible name; wait for page text such as "Needs review" instead.
- `kill-backend` fails with "nothing is listening" or "the backend is not up" while a restart is in progress; retry it once the banner clears.
- Relaunch opens Dashboard.
- The helper sets `GLASS_HOME` per run so it never touches the user's real `~/.project-glass`. `HOME` stays the user's, so `gh` still finds their login.
