# Docker Cloud Sandboxes

Runs ordinary OpenCode Agents in Docker's native OpenCode cloud environment. Glass also needs the
OpenCode adapter from this branch; changing a Sandbox image alone isn't sufficient.

Install the [sbx CLI](https://docs.docker.com/ai/sandboxes/cloud/), activate Docker Cloud access,
then run `sbx login` and `sbx --cloud diagnose` from the same account that launches Glass.
The tested CLI is **0.50.1**, native OpenCode **1.19.5**, and Glass client **1.15.13**.

Copy this folder to `~/.project-glass/plugins/docker-cloud/`, including `index.ts`, `launch.mjs`,
and `glass-plugin.ts`, then restart Glass. No npm install is needed in the Plugin folder. The
contract is copied because `@glass/plugin` isn't published. Copy its current source again when
upgrading the Plugin alongside Glass.

```powershell
$destination = Join-Path $HOME '.project-glass/plugins/docker-cloud'
New-Item -ItemType Directory -Force -Path $destination
Copy-Item examples/docker-cloud/index.ts,examples/docker-cloud/launch.mjs,examples/docker-cloud/glass-plugin.ts -Destination $destination
```

On macOS/Linux:

```sh
mkdir -p ~/.project-glass/plugins/docker-cloud
cp examples/docker-cloud/{index.ts,launch.mjs,glass-plugin.ts} ~/.project-glass/plugins/docker-cloud/
```

Choose **Docker Cloud Sandboxes → OpenCode** in New Agent. Default and **Big Pickle** both run
`opencode/big-pickle`. That model worked without a model API key and had zero token cost in the
verified catalog; availability and pricing can change. Docker compute is billed separately: see
[Docker signup and billing](https://docs.docker.com/agentic-platform/signup/#billing).
The initial catalog is deliberately limited to that verified model and allocates no machine.
No local OpenCode installation is needed for cloud Agents.

Each machine requests **1 CPU / 2 GiB**, Linux amd64, and **24 hours with automatic deletion**.
It continues running and billing when Glass is closed. Extend reports the actual fixed expiry;
it doesn't promise a renewal beyond Docker's maximum lifetime. Push work you want to keep before
removing the Agent or reaching expiry.

Public clones work anonymously. For private repositories or authenticated pushes, configure a
Docker-managed GitHub token with access to that repository before creating an Agent:

```sh
sbx --cloud secret set github
```

This Plugin doesn't copy your local GitHub, Claude, pi, or OpenCode logins. Other model credentials
aren't required for the bootstrap model. Docker's network policy allows GitHub, OpenCode's model
service/catalog, and npm for the private Node 24 installation. Add project-specific domains to the
Plugin's allowlist if the repository needs other package registries or services.

The Plugin clones your selected base branch, keeps `origin/<base>`, and checks out the Agent's
branch. It uploads Glass's self-contained host and installs Node 24 under `/home/agent/.glass`.
Only the authenticated Glass host port is published. OpenCode's authenticated API stays on
loopback inside the machine. Host output is in `/home/agent/.glass/host.log`.

To check the installation:

1. Start an OpenCode Agent in Docker Cloud Sandboxes on a public repository.
2. Send `Reply GLASS_OK, then use your shell tool to print TOOL_OK.` and watch the completed Turn
   and tool output. Open Changes to confirm the clone and base branch work.
3. Start a longer tool action, close Glass, then reopen it. Confirm the same Agent reconnects and
   its transcript has one copy of the output. Send another message in the same conversation.
4. Find its exact `glass-…` name and ID with `sbx --cloud ls`. Remove that Agent in Glass and confirm **Remove Agent** if it asks to discard test changes.
5. Run `sbx --cloud inspect <exact-name-or-id> --json` and confirm **not found**. A successful
   remove request alone isn't deletion confirmation.

Creation records the unique machine name before requesting allocation. Glass can therefore remove
a half-built machine after cancellation or a lost CLI response. If Glass reports a cleanup failure,
retry Remove; to recover manually, inspect that exact recorded name and run
`sbx --cloud rm --force <exact-name-or-id>`, then inspect again. Never delete unrelated machines.

For a local OpenCode Agent, install OpenCode 1.19.5 and configure its model/login in your terminal.
Glass uses `opencode` on PATH; set `opencodeCommand` in Glass's `settings.json` to an explicit
executable path and restart Glass if needed. OpenCode isn't offered for Tours, Agent reviews,
review Follow-ups, or the Global conversation.

For local OpenCode, **Default model** uses the worktree's native configuration when the Agent
first starts, and keeps that default with its saved conversation. The repository-independent
picker does not label it with a model name from your home folder. Pick a named model to make
the choice explicit.
