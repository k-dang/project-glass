# The Activity log is one SQLite log of typed Activities, and the source of truth

Later features, agents among them, will search what the user did, so every feature records its
Activities in one log. Each Activity is a typed Schema in `packages/contracts`, stored as its kind
and a JSON payload, so a new kind needs no migration. Each kind carries what it was done to, such
as the PR and its Revision or the To-do, so every feature's Activity shares the one log without
fitting a PR-shaped envelope.

The log is the source of truth and holds no search index. Full-text or vector search is a derived
index built from it when a reader exists, and can be rebuilt or replaced without touching the log.

The log is the backend's first store, a SQLite database through `effect/sql` and
`@effect/sql-sqlite-node`, which uses Node's built-in `node:sqlite` and so needs no native module
rebuilt for Electron. Settings that only need loading, such as the followed repositories, stay in
`settings.json` beside it.

## Consequences

Recording is best-effort: a failure is logged, never shown, and does not turn a successful action
into a failure.

## Revisit when

- The log needs to be shared across devices or users, which a local SQLite file can't do.
