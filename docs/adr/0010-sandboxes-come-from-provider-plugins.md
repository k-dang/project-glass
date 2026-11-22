# Sandboxes come from Sandbox provider plugins

Glass ships no knowledge of any Sandbox platform: no internal packages, hosts, images, or login
details. A Sandbox provider is a plugin the user installs, and it creates, reaches, and deletes
Sandboxes. A company's own Sandbox platform is one such plugin, kept outside this repository, so it
can use internal packages and name internal hosts without Glass depending on them. The agent host,
its journal, and the backend as the transcript of record (ADR 0007) are the same for every
provider. A Sandbox's Thread reaches Glass's tools over the connection Glass already holds to
its host (ADR 0013), so a provider opens no other way into this device.

The seam is coarse: Glass hands a provider what the agent host needs, and the provider does
everything specific to its platform, including logins, cloning, and starting the host.
`@glass/plugin` is the contract. It uses Promises and `AbortSignal`, so a plugin needs no Effect.

Plugins install as files in a folder and run in the backend process, as pi extensions do. Glass
keeps each provider's state as opaque JSON on the Thread's row, so that row stays the one
record of the Thread and providers need no storage of their own. Because Glass holds that
state, it can delete a half-built Sandbox even after a crash mid-provisioning.

A Sandbox outlives Glass, so its Turns keep running while Glass is closed, and Glass reconnects to
its host at launch from the last journal position it saved. That position belongs to one host
instance, so each connection starts with a handshake naming the host's instance and protocol
version: a replaced host's journal is followed from its start, and its Thread's running Turn
is cut off. A Sandbox keeps its host across Glass upgrades, so when that host speaks another
protocol Glass ends it and has the provider start Glass's own in its place. Starting the host is
therefore a provider call of its own, `startHost`, which every new Sandbox goes through too, so
the upgrade runs the same code as creation. Glass saves that a replacement is under way before it
ends the old host, so one that fails part-way is tried again, even after a relaunch. The Agent
harness keeps its session on the Sandbox's disk, so the Thread's agent remembers its work; only
the Turn the old host was running, and what it hadn't yet delivered, are lost. Calls to a provider
stay bounded: Glass stops retrying a Sandbox it can't reach until the user or a relaunch starts
over.

This device is the same seam's built-in placement, so the Threads service only calls
placements and local and Sandbox Threads differ only in where their host runs.

## Considered options

- **Depend on the platform's internal SDK**: how Glass first provisioned Sandboxes. Least code, but
  it lives on an internal registry Glass's CI can't reach, and it puts internal hosts, images, and
  login details in this repository.
- **The platform's public client, with internal values in local config**: no internal package,
  but Glass would still carry one platform's provisioning, credentials, and signing.
- **Fine-grained primitives, like pi's tool `Operations`**: providers would offer exec, upload,
  and endpoints, and Glass would clone, upload, and start the host itself. Every provider would be
  small and Sandboxes would set up alike, but the seam would assume a Linux machine with git and
  Node, and logins would still need a provider hook. The Vercel and Upstash providers share their
  GitHub login and clone, but each platform differs where the seam matters: how files get in, how
  credentials leave, and how a stopped machine restarts its host.
- **The host replaces itself**: Glass would send the new bundle to the running host, with no
  provider call. But how a process outlives the command that started it differs by platform,
  which is what a provider knows, and the hosts already running couldn't do it.
- **A Thread stays read-only while its host speaks another protocol**: how Glass first handled
  upgrades. Nothing to add to the seam, but every protocol change stranded every Sandbox Thread.
- **Plugins in a child process**: a crashing or blocking plugin couldn't stall the backend, as ADR
  0001 isolates the backend from the windows, at the cost of an IPC protocol for the seam. Providers
  do their work through async calls, so the backend process is enough.
- **Plugins listed in Glass's settings, with options, as opencode does**: explicit, but a folder
  is how pi extensions install, and a provider that keeps its own values needs no options.
- **Providers keep their own state**: Glass would need a storage API for plugins, and removing a
  Thread would span two stores.

## Revisit when

- Several providers duplicate the same setup, which would favour fine-grained primitives.
- A plugin stalls or crashes the backend in practice, which would favour a child process.
- A provider needs options from the user or storage beyond its Sandbox state.
