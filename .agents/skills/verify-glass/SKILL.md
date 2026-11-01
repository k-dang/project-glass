---
name: verify-glass
description: Launch the Glass Electron desktop app in an isolated instance, drive its window over the Chrome DevTools Protocol (accessibility-tree clicks, text waits, screenshots), and capture evidence. Use to prove a Glass change works the way a user sees it, to reproduce a Glass bug end to end, or to check the standalone backend's HTTP surface.
---

# Verify Glass

Glass is an Electron app (`apps/desktop`) whose window loads its built React renderer (`apps/desktop/dist/renderer`) from `glass://app/index.html` and talks to an Effect backend (`apps/server`) that the main process runs in a `utilityProcess` on a random `127.0.0.1` port. All driving goes through one helper:

```sh
node .agents/skills/verify-glass/scripts/glass-verify.ts <command>   # `help` lists commands
```

Read [`features/README.md`](features/README.md) before driving; each feature file there is the recipe.

## Launch

Run from the repo root. First time in a checkout: `mise trust && mise install && pnpm install`.

```sh
V=.agents/skills/verify-glass/scripts/glass-verify.ts
node $V launch                                  # real GitHub, local Pi provider; no model charges
node $V launch --tour-provider real             # live model provider; may incur charges
node $V launch --github fake --fake-mode 401    # fake GitHub: ok | 401 | 500 | down | busy-500
node $V launch --no-credentials                 # no token env vars, gh hidden from PATH
node $V launch --github fake --fail-backend-start  # the backend exits as it starts
node $V launch --backend fake                   # pnpm dev:fake's backend, with demo PRs and Agents;
                                                # Claude Code runs the pinned claude on a fake Anthropic API
```

`launch` runs `pnpm build` (skip with `--no-build` when the build is current), starts Electron with `--remote-debugging-port` and its own `--user-data-dir`, and returns once the window is at `glass://app/index.html` and the backend answers `/health`. It prints `Ready: run <id> ...`; pass `--run <id>` to name the run.

Each run is isolated under `.verify/<id>/` (gitignored): its own Electron profile, its own `GLASS_HOME` (so backend logs and data files go to the run, not `~/.glass/logs` and `~/.project-glass`), its own ports. Several runs can live side by side; then every command needs `--run <id>`.

With `--github fake`, the backend's `GLASS_GITHUB_API_URL` points at the shared fake in `apps/server/test/fakeGitHub.ts`. It answers `GET /user` as `octocat` (`ok`), HTTP 401, HTTP 500, or a dropped connection (`down`), and `GH_TOKEN` is a dummy. In `ok` mode it also answers the PR list reads (the full read of open PRs, the catch-up search, and checks) with four Needs review PRs (Passing, Failing, Running, and Unavailable checks), two My PRs (one a draft), and one Reviewing PR per followed repository; a repository named `quiet` has none and one named `busy` supplies 134 Needs review PRs alongside My PRs and Reviewing. `busy-500` answers like `ok` except that every PR list read of the `busy` repository fails with HTTP 500. Listed PRs open into a PR workspace with a one-file diff; `octo-org/glass#101` is the exception, 150 generated files for scroll and memory runs. Drafts, Reviews, and Tours use the shared fake too. That env var is the backend's real GitHub boundary, so everything from the renderer to the HTTP call is production code. Change its answer mid-run with `node $V fake-github <mode>`.

Tour verification defaults to `--tour-provider fake`. Choose **pi** as the Tour engine in Settings → Tours before **Write Tour**. Your installed `pi` calls a local provider that returns a clearly marked synthetic Chapter covering the PR's actual changed paths. Pi credentials and model settings live inside the run; Claude Code is disabled to prevent accidental paid calls. GitHub still uses the chosen `--github` mode. See [Tours](features/tours.md) for the recipe. Choose `--tour-provider real` explicitly to use your normal Pi configuration and Claude Code installation; this may incur model charges.

## Doctor

```sh
node $V doctor
```

Read-only. Checks an Electron process serves the run's CDP port, that port belongs to our Electron (prints its version), the window shows the built renderer, the backend answers `/health` with the run's secret, the helper-owned fake providers are up, and the build is newer than every source file. For `--backend fake`, it labels GitHub as backend-owned and Tours as synthetic runners; the fake Anthropic API supplies the pinned real Claude CLI. Exit code 1 on any `FAIL`. Run it first whenever anything looks off; a stale-build `FAIL` means relaunch without `--no-build`.

## Drive

| Command                                          | Does                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `text`                                           | prints `document.body.innerText`                                                            |
| `snapshot <name>`                                | prints the accessibility tree as `role "name"` lines, saves `evidence/<name>.aria.txt`      |
| `screenshot <name>`                              | saves `evidence/<name>.png`                                                                 |
| `click --role <role> --name <name>`              | finds the element in the accessibility tree and dispatches a real mouse click at its center |
| `type --role <role> --name <name> --text <text>` | clicks the element, then replaces its contents with `<text>` as a paste would               |
| `press --key <key> [--meta]`                     | presses a key such as `Enter` or `ArrowUp` in the focused element, holding ⌘ with `--meta`  |
| `wait --text <text> [--timeout ms]`              | polls the window text (default 15s); exit 1 on timeout                                      |
| `scroll --by <pixels> [--x n] [--y n]`           | turns the wheel over the window, for views that load as you scroll                          |
| `memory [--samples n] [--interval ms] [--out n]` | samples renderer, worker, and process memory into `evidence/<out>.jsonl`, then prints deltas |
| `fake-github <mode>`                             | changes the fake GitHub's answer for the next request                                       |
| `kill-backend`                                   | kills the window's current backend process, as a crash would                                |

Target elements by accessible role and name from a `snapshot` (e.g. `--role button --name "Try again"`), never by coordinates. Use `wait`, not `sleep`, after any action that triggers an RPC.

For anything not covered, `node $V doctor` prints the CDP port; `http://127.0.0.1:<port>/json/list` gives the page's WebSocket URL for raw CDP.

## Memory

`memory` samples a live run, writes one JSON line per sample to `evidence/<out>.jsonl`, and prints what moved:

```sh
node $V memory --samples 30 --interval 1000 --out baseline
```

Each line holds the renderer's V8 heap, Blink counters and DOM counts, every worker target's own heap, and every process under the app's main process with its role and memory. The renderer numbers come from CDP (`Performance.getMetrics`, `Runtime.getHeapUsage`, `Memory.getDOMCounters`); worker heaps need `Target.setAutoAttach`, because a worker's V8 isolate is not part of the page's numbers. Process figures come from the OS (`Get-CimInstance Win32_Process`, or `ps`), because CDP cannot see RSS, the GPU process, main, or the backend.

`rss` is the working set the app's own RAM readout sums, so shared pages count once per process and the total is an upper bound. `private` is the commit charge and the steadier number; compare `total private` across commits. A sample costs about a quarter second on Windows, so `--interval 1000` yields roughly one sample a second.

Measure a workload, not an idle window: what matters is what it adds and what it keeps afterwards. The repeatable one is the fake's 150-file PR (see [Changed files](features/changed-files.md)). `memory` runs in the foreground for the whole sample window, so drive from a second shell:

```sh
node $V launch --github fake            # follow octo-org/glass; open "Wide change across 150 files"
node $V memory --samples 80 --out baseline   # shell 1
node $V click --role tab --name Changes      # shell 2, then scroll --by 9000 to the last file
```

Sampling is read-only, but it attaches a debugger to the window's target, which fails while DevTools is open on that window.

## Evidence

Everything lands in `.verify/<id>/evidence/`: your snapshots and screenshots, plus on `stop`, `electron.log` (main-process and backend stdout), `backend.log`, `fake-github.log` (one line per GitHub request with the mode that answered it), and `fake-pi.log` (completion timestamps and file counts; no prompts or credentials).

Proof standards:

- Drive the real user path: clicks on the window, real backend, real RPC. Never call `window.glass` or the backend directly to _cause_ a state.
- Capture the action and the resulting state: a snapshot/screenshot before and after, not only the final screen.
- Verify side effects alongside the UI: `fake-github.log` proves the click reached GitHub; `stop` prints whether the backend port closed.
- Use the fake only for GitHub states you can't produce honestly; prove the happy path once against real GitHub when the change touches it.
- A fake-provider Tour proves the app, SDK transport, saving, and rendering. Report it as synthetic; live authentication and model output quality require a real-provider run.
- Look at every screenshot with the Read tool; layout or copy that looks off is a finding.

## Cleanup

```sh
node $V stop        # or: node $V stop --run <id>
node $V list        # runs that still have live state
```

`stop` requests app shutdown with CDP `Browser.close` without waiting for a protocol reply. It follows a relaunch in progress and counts Glass as quit once nothing has served the run's CDP port for 2s. After 15s it falls back to killing the tree of whichever process serves that port, and if Glass still runs it fails and keeps the run state. Otherwise it kills the run's fake GitHub and Pi provider, reports whether the backend port closed, copies logs into `evidence/`, and deletes `.verify/<id>/state/`. Evidence survives. Never kill `electron.exe` by name: the user may have their own Glass or another Electron app running. Delete `.verify/<id>/` yourself only once the proof is no longer needed.

If `launch` fails midway, still run `stop --run <id>` so a half-started Electron doesn't linger.

## Gotchas

- `launch` builds into the same `dist/` folders `pnpm dev` watches. If the user is running `pnpm dev` in this checkout, use `--no-build` (doctor will say if the build is stale) or the dev Electron will restart under them.
- Never pipe `launch` (`| tail`, `| grep`): on Windows the detached app and fake GitHub inherit the pipe, so the pipeline never ends even though `launch` returned. Run it bare or redirect to a file.
- Don't drive the user's own Glass window; it has no debug port anyway. Only drive runs `launch` started.
- `--no-credentials` hides every PATH directory containing `gh`; anything else in those directories is hidden from the app too.
- On Windows, run the helper from Git Bash or PowerShell with `node`; it does not depend on a shell.
