# Local Threads outlive the app

Quitting Glass used to end every local Turn, even though the agent host, not the backend or the
windows, does the work (ADR 0007). Now the backend starts the local host detached and leaves it
running on quit, so a Turn keeps going while Glass is closed, as a Sandbox's does (ADR 0012). On the
next launch the backend finds the host from a record in the data directory, asks which Turns it
hasn't yet handed over the end of, and follows its journal from what each Thread last saved. Every
other running Turn ends interrupted.

The host stops itself, rather than on a timer, once no backend follows its journal, no Turn is
running, and a backend has acknowledged everything in the journal. The journal lives only in the
host's memory, so a Turn that ends while Glass is closed, or waits on a Permission request, keeps
its host until Glass opens again. Starting a new host later costs nothing, because Claude Code and
pi pick up a Thread from their own saved sessions. A host whose record is gone or names another
host also stops, so a host Glass forgot, or whose data directory was deleted, doesn't run until the
device restarts.

Glass reattaches only to a host with the same fingerprint, meaning the same host bundle and harness
commands, and asks any other to shut down. Sandboxes reattach to any host that speaks the same
protocol, but a local host that does would keep running old harness code for as long as Glass stays
open.

## Considered options

- **Keep the whole backend running as a daemon** (ADR 0001's deferred option): only the host does
  the work, and it already runs as its own process.
- **Stop an unattended host after a fixed time**: this would end Turns that are rightly waiting on
  the user, and lose what a finished Turn wrote. Reopening Glass already lets them finish.
- **Stop the host when its last Turn ends, writing the journal to disk first**: a second record
  of the transcript to keep in step with Glass's database, just to save an idle process.
- **Drain an old host while a new one takes new Turns**: two local hosts and two journals to follow,
  just to save the Turns that are running during an update.

## Consequences

- Background work that a Claude Code agent leaves running after its Turn ends doesn't keep the
  host alive, so quitting Glass still ends that work.
- The Global chat still ends interrupted on relaunch. Its pi holds a Glass tools
  credential that died with the backend, so Glass stops it on the host and starts it again.
- The token sits in a file only this user can read. Anyone who can read the data directory can
  already read Glass's database.
