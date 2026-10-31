# Sandboxes come from Sandbox provider plugins

Glass ships no knowledge of any Sandbox platform: no internal packages, hosts, images, or login
details. A Sandbox provider is a plugin the user installs, and it creates, reaches, and deletes
Sandboxes. A company's own Sandbox platform is one such plugin, kept outside this repository, so it
can use internal packages and name internal hosts without Glass depending on them. This amends ADR
0007, which had the backend provision Sandboxes itself. The agent host,
the journal, and the backend as the transcript of record are unchanged.

## The seam

Glass scans `~/.project-glass/plugins/*` at backend start, as pi scans its extension folders. An
entry is a file, a folder with an `index.ts` or `index.js`, or a folder whose `package.json` names
its entry in a `"glass"` field. jiti loads it, so a plugin can be TypeScript and bring its own
`node_modules`. Its default export is a factory, `(glass) => void | Promise<void>`, that calls
`glass.registerSandboxProvider(id, provider)`, with an `id` of lowercase letters, digits, and
dashes. Plugins run in the backend process: the user installs them, as they install pi extensions.
A plugin that fails to load, or whose factory doesn't finish within 10 seconds, is logged and
skipped; the rest still load.

A provider is coarse, like opencode's workspace adapters: Glass hands it what the agent host
needs, and the provider does everything specific to its platform.

- `name` is what the user sees for this kind of Sandbox.
- `create(request, { progress, record, signal })` makes the Sandbox, sets up the user's logins,
  clones the repository onto the Agent's branch from its base branch, and uploads and starts the
  agent host bundle with the environment and port Glass gives it. It calls `record(state)` as soon
  as the Sandbox exists and reports each step through `progress`.
- `target(state)` answers the host's URL and headers, freshly, for each connection.
- `remove(state)` deletes the Sandbox. Glass first asks the agent host to end, with its agent
  programs, so a provider needn't track the host's processes. If the host can't be reached,
  `remove` runs anyway.
- `models(engine)` lists what each Agent program offers in its Sandboxes, before one exists.

The plugin API is Promises and `AbortSignal`, so a plugin needs no Effect; its types are the
`@glass/plugin` package. Glass passes in `glass.missingLogin(login, fix)` and
`glass.noCapacity(message)` for the failures the user can act on; anything else a provider throws
becomes a safe failure, with the cause in the backend log.

Glass stores the `state` a provider records as opaque JSON on the Agent's row, so the row stays
the one record of the Agent and providers keep no storage of their own. If `create` fails or is
cancelled after recording, Glass calls `remove` with that state, so a half-built Sandbox is always
deleted, even after a crash mid-provisioning. Providers must read state written by their earlier
versions.

This device is the same seam's built-in placement: creating makes a worktree of the Local
checkout, the target is the one local agent host, and removing removes the worktree. The Agents
service only calls placements, so local and Sandbox Agents differ only in where their host runs.

## Considered Options

- **Depend on the platform's internal SDK (ADR 0007)**: least code, but it lives on an internal
  registry Glass's CI can't reach, and it puts internal hosts, images, and login details in this
  repository.
- **The platform's public client, with internal values in local config**: no internal package,
  but Glass would still carry one platform's provisioning, credentials, and signing.
- **Fine-grained primitives, like pi's tool `Operations`**: providers would offer exec, upload,
  and endpoints, and Glass would clone, upload, and start the host itself. Every provider would be
  small and Sandboxes would set up alike, but the seam would assume a Linux machine with git and
  Node, and logins would still need a provider hook. One provider exists, so its duplication is
  hypothetical.
- **Plugins in a child process**: a crashing or blocking plugin couldn't stall the backend (ADR
  0004's concern), at the cost of an IPC protocol for the seam. Providers do their work through
  async calls, so the backend process is enough.
- **Plugins listed in Glass's settings, with options, as opencode does**: explicit, but a folder
  is how pi extensions install, and a provider that keeps its own values needs no options.
- **Providers keep their own state**: Glass would need a storage API for plugins, and removing an
  Agent would span two stores.
