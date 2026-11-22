# Vercel Sandboxes

A Sandbox provider Plugin (ADR 0010) that runs pi Threads in
[Vercel Sandboxes](https://vercel.com/docs/sandbox). Each Thread gets its own persistent Sandbox
in a Vercel project named `glass-sandboxes`, which the Plugin creates on first use.

## Logins

The Plugin uses the logins you already have, and no secret enters a Sandbox:

- **Vercel**: your Vercel CLI login (`vercel login`), in your default team.
- **Models**: pi talks to [AI Gateway](https://vercel.com/docs/ai-gateway) with the
  `glass-sandboxes` project's OIDC token, so usage bills to that team. The project needs OIDC on,
  which new projects have.
- **GitHub**: your GitHub CLI login (`gh auth login`), for cloning, pushing, and `gh` in the Sandbox.

The Sandbox firewall adds the AI Gateway and GitHub credentials to requests as they leave the
Sandbox, so pi, git, and `gh` inside it hold only placeholders. The Plugin refreshes them each time
Glass connects.

## Install

Copy this folder into Glass's plugins folder, install its dependencies, then restart Glass. Run from
the repository root:

```sh
mkdir -p ~/.project-glass/plugins
cp -r examples/vercel-sandboxes ~/.project-glass/plugins/
(cd ~/.project-glass/plugins/vercel-sandboxes && npm install)
```

```powershell
New-Item -ItemType Directory -Force ~/.project-glass/plugins
Copy-Item -Recurse examples/vercel-sandboxes ~/.project-glass/plugins/
Push-Location ~/.project-glass/plugins/vercel-sandboxes; npm install; Pop-Location
```

Its `@earendil-works/pi-ai` version lists pi's models and must match the pi on Vercel's `universal`
image and the pi Glass pins; update all three together.

## How it behaves

- Sandboxes run pi only, on any AI Gateway model pi knows, defaulting to Claude Sonnet 5.5.
- A Sandbox session lasts at most 45 minutes, the Hobby plan's limit. When a session ends, Vercel
  stops the Sandbox and keeps its files; the next time Glass connects, the Plugin resumes it and
  restarts the agent host, and a Turn that was running is cut off.
- After a Glass upgrade that changes how Glass talks to the agent host, Glass has the Plugin replace
  the host in each Sandbox; a Turn that was running is cut off.
- Removing the Thread deletes the Sandbox and its snapshots.

## Check it

1. Start a pi Thread in Vercel Sandboxes, pick Claude Haiku 5.5, and send
   `Use bash to run: echo TOOL_OK && git status -sb && gh api user --jq .login`. The reply shows
   `TOOL_OK`, the Thread's branch, and your GitHub login.
2. Stop its Sandbox from the `glass-sandboxes` project's Sandboxes page in the Vercel dashboard
   (names start with `glass-`), restart Glass, and send another message: it answers from the
   resumed Sandbox.
3. Remove the Thread and confirm the Sandboxes page no longer lists its Sandbox.
