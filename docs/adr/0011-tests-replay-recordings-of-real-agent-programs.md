# Tests replay recordings of the real Agent programs

Glass's use of Claude Code and pi is tested by replaying recordings of the real programs, matched
launch by launch and message by message, so a change in what Glass sends fails until it is recorded
again. Glass's own rules are tested at seams Glass owns. Recordings also capture model behaviour a
hand-written fake can't.

A session recording names the pinned SDK or bundled pi version it came from, and its replay fails
once that pin moves, because Glass ships those versions. A runner recording only notes its version,
since users run whichever `claude` and `pi` they have.

## Considered Options

- **A hand-written fake `claude`**: free to run and needs no login, but Glass built this first and it
  encoded wrong beliefs about the CLI, such as its model list and asking before read-only commands,
  while its tests passed. Fakes remain only for failures a real program won't produce on demand.

## Consequences

Changing what Glass sends, or moving a pin, means recording again with a real login and a small
model cost.

## Revisit when

- Recording again becomes costly or flaky enough that people avoid changes to avoid it.
- An Agent program publishes a test harness or protocol conformance suite of its own.
