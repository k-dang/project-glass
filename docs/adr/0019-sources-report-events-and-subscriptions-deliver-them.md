# Sources report Events, and Subscriptions deliver them

Glass reacted to things the user didn't do through hand-wired streams, one per reaction: a Started
work update, To-dos completing on merge. A Thread handling its own PR would have added more, each
with its own delivery bookkeeping, and nothing said why a Thread had woken. Now a Source reports
what happens as Events into one SQLite log, and a Subscription tells a Thread about the Events on
its subject in an Update. The two older streams still run by themselves.

The log is what gets delivered. Each Subscription keeps a cursor into it, and Glass moves the cursor
past the Events an Update carries in the same transaction that starts the Update's Turn, so each
Event is told once, also across a restart. Glass waits until the Thread is idle and sends one Update
with every new Event, oldest first, when at least one is of a kind the Subscription asked for.
Glass doesn't decide whether an Event still holds: checks that failed and passed again while the
Thread was busy arrive as both Events, and the agent judges what is left to do.

A Source only reports Events with a schema and checks what a Subscription may be about. Delivery,
who may subscribe, giving up after three Updates in a row, and running three at once know nothing
about where Events come from. GitHub is the only Source, and it reports Events only for PRs a
Subscription covers, by comparing each read of the PR mirror with the one before; the first read
for a Subscription reports what already stands. The mirror is already polled, and a desktop app has
no public address for webhooks.

## Considered options

- **Deliver what is still true, decided from the PR's state**: no stale Updates, but every Source
  must say what holds now, which a set time or a webhook can't, and telling each state once needs
  its own bookkeeping per reason.
- **Each Event as its own Turn or a Steer**: a burst of Events becomes a burst of Turns, and a Steer
  cuts into the user's work.
- **No log, one derived stream per reaction**: what Glass had. Each reaction reinvents delivery,
  and "why did this Thread wake?" has no answer.
- **Webhooks**: need a public address or a relay the user doesn't run.

## Consequences

- An Update can tell the agent about something already undone, at the cost of a short Turn.
- A Subscription that gave up keeps its Events, and the next message the Thread gets lets them
  through.
- Something that happens and is undone between two reads of the mirror is never an Event.
- Glass reports nothing while it is closed, and the first read after it opens reports what changed.
- A new Source, such as a schedule or a folder, adds Events and a subject; delivery stays as it is.
