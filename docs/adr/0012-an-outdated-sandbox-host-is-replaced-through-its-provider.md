# An outdated Sandbox host is replaced through its provider

A Sandbox outlives Glass, so its Turns keep running while Glass is closed, and it keeps its agent
host across Glass upgrades. Glass reconnects to that host at launch from the last journal position
it saved, which belongs to one host instance, so each connection starts with a handshake naming the
host's instance and protocol version. A replaced host's journal is followed from its start, and its
Thread's running Turn is cut off. A host that speaks another protocol is ended, and the provider
starts Glass's own in its place.

Starting the host is therefore a provider call of its own, `startHost`, which every new Sandbox
goes through too, so an upgrade runs the same code as creation. The Agent harness keeps its session
on the Sandbox's disk, so the Thread's agent remembers its work; only the Turn the old host was
running, and what it hadn't yet delivered, are lost.

## Considered options

- **The host replaces itself**: Glass would send the new bundle to the running host, with no
  provider call. But how a process outlives the command that started it differs by platform,
  which is what a provider knows, and the hosts already running couldn't do it.
- **A Thread stays read-only while its host speaks another protocol**: how Glass first handled
  upgrades. Nothing to add to the seam, but every protocol change stranded every Sandbox Thread.
