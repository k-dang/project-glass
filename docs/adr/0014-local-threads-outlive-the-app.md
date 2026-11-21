# Local Threads outlive the app

Quitting Glass used to end every local Turn, even though the agent host, not the backend or the
windows, does the work (ADR 0007). Now the backend starts the local host detached and leaves it
running on quit, so a Turn keeps going while Glass is closed, as a Sandbox's does. The backend
records the host's port, token and fingerprint in the data directory. On the next launch it finds
the host there, asks which Turns it hasn't yet handed over the end of, and follows its journal from
what each Thread last saved. Those Turns are the ones still running and the ones that ended
while Glass was closed. Every other running Turn ends interrupted.

The host stops itself once no backend follows its journal, no Turn is running, and a backend has
acknowledged everything in the journal. So when Glass quits with nothing running, the host stops
right away. A Turn that ends while Glass is closed keeps its host, idle, until Glass opens and saves
what the Turn wrote, because the journal lives only in the host's memory. A Turn that waits on the
user, such as one with a Permission request, also keeps its host until Glass opens again. Starting
a new host later costs nothing, because Claude Code and pi pick up a Thread from their own
saved sessions.

The record is how a host knows Glass will come back for it. The host reads the record once a minute,
and it stops if the record is gone or names another host while no backend follows its journal.
Glass forgets a host it gives up on even when the host never hears the shutdown request, and a
deleted data directory takes its record with it, so without this check such a host would run until
the device restarts.

Glass reattaches only to a host with the same fingerprint, meaning the same host bundle and harness
commands, and never to one that is gone. A host that refuses the connection is gone; one slow to
answer is busy with its Turns, not dead. It asks any other host to shut down and ends that host's
Turns interrupted. Sandboxes reattach to any host that speaks the same protocol, but a local host
that does would keep running old harness code for as long as Glass stays open.

The host writes its logs to the backend log file itself, because a pipe through the backend would
break once the backend quits.

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
