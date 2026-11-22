# Upstash Boxes

A Sandbox provider Plugin (ADR 0011) that runs Claude Code Threads in
[Upstash Boxes](https://upstash.com/docs/box/overall/quickstart). Each Thread gets its own Box,
named `glass-` and a random id.

## Logins

The Plugin uses three logins, and none of them enters a Box:

- **Upstash Box**: a Box API key from the [Upstash Console](https://console.upstash.com/box), which
  the Plugin uses from this device.
- **Claude**: your Claude subscription, through a 1-year token from `claude setup-token`.
- **GitHub**: your GitHub CLI login (`gh auth login`), for cloning, pushing, and `gh` in the Box.

Upstash's proxy adds the Claude and GitHub tokens to requests as they leave a Box, so Claude Code,
git, and `gh` inside it hold only placeholders. Upstash takes those tokens only when it creates a
Box, so a Box keeps the ones it was made with. After you renew or revoke one, new Threads use the
new token, but older Threads' Boxes keep the old one and can't use the service it was for.

## Install

Copy this folder into Glass's plugins folder and install its dependencies. Run from the repository
root:

```sh
mkdir -p ~/.project-glass/plugins
cp -r examples/upstash-boxes ~/.project-glass/plugins/
(cd ~/.project-glass/plugins/upstash-boxes && npm install)
```

```powershell
New-Item -ItemType Directory -Force ~/.project-glass/plugins
Copy-Item -Recurse examples/upstash-boxes ~/.project-glass/plugins/
Push-Location ~/.project-glass/plugins/upstash-boxes; npm install; Pop-Location
```

Run `claude setup-token` for the Claude token. Then create `.env` in the copied folder with an
editor, so the keys stay out of your shell history, and put each value on one line:

```sh
UPSTASH_BOX_API_KEY=<key>
CLAUDE_CODE_OAUTH_TOKEN=<token>
```

Restart Glass. It reads the keys each time it needs one, so later changes need no restart.

## How it behaves

- Boxes run Claude Code only, the version Upstash installs, offering Sonnet, Fable, Opus, and Haiku.
  Upstash's Boxes don't include pi.
- Upstash pauses a Box it counts as idle, after 1 hour on its free plan and 6 hours on paid plans,
  and keeps its files. The next time Glass connects, the Box resumes and restarts the agent host. A Turn
  that was running when the Box paused is cut off.
- After a Glass upgrade that changes how Glass talks to the agent host, Glass has the Plugin replace
  the host in each Box; a Turn that was running is cut off.
- Removing the Thread deletes the Box.

## Check it

1. Start a Claude Code Thread in Upstash Boxes, pick Haiku, and send
   `Use bash to run: echo TOOL_OK && git status -sb && gh api user --jq .login`. The reply shows
   `TOOL_OK`, the Thread's branch, and your GitHub login.
2. Pause its Box from the [Upstash Console](https://console.upstash.com/box) (names start with
   `glass-`), restart Glass, and send another message: it answers from the resumed Box.
3. Remove the Thread and confirm the console no longer lists its Box.
