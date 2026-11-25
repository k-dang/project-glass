# Events are recorded in full and delivered as what is still true

Glass reacted to things the user didn't do through hand-wired streams, one per reaction: a Started
work update, To-dos completing on merge. A Thread handling its own PR would have added more, each
with its own delivery bookkeeping, and nothing said why a Thread had woken. Now what happens to a PR
is an Event from a Source, recorded in one SQLite log, and a Subscription tells a Thread about some
of them in an Update. The two older streams still run by themselves.

An Update is not a replay of the log. Glass waits until the target is idle and sends one Update
carrying what is still true then, so checks that failed and passed again while a Turn ran wake
nobody. What to send is decided from the current state and what the Subscription was last told. The
log is a record, not a queue: it says which Events led to an Update, and losing it loses history,
never pending work.

GitHub's Events come from comparing each read of the PR mirror with the one before. The mirror is
already polled, and a desktop app has no public address for webhooks.

## Considered options

- **Deliver every Event, as its own Turn or a Steer**: Glass would own ordering and exactly-once
  delivery across restarts, and a Thread would be asked to fix what is already fixed.
- **No log, one derived stream per reaction**: what Glass had. Each reaction reinvents delivery,
  and "why did this Thread wake?" has no answer.
- **Webhooks**: need a public address or a relay the user doesn't run.

## Consequences

- Something that happens and is undone between two reads of the mirror is never an Event.
- A missed poll, a restart, or Glass being closed needs no catching up: the next read sees the
  state, and the Update follows from it.
- Nothing reacts while Glass is closed.

## Revisit when

- A Source reports things with no lasting state, such as a set time arriving. Those have nothing
  that is "still true" to deliver and need delivering once, even late.
