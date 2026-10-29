# The Activity log is the backend's first store, in SQLite

Agents and later features will search what the user did, so the backend keeps an Activity log in
`~/.project-glass/glass.db`, a SQLite database through `effect/sql` and `@effect/sql-sqlite-node`,
which uses Node's built-in `node:sqlite` and so needs no native module rebuilt for Electron.
Everything later features will search is kept here; the settings that only need loading, such as
the followed repositories, stay in `settings.json` beside it. Each Activity is a typed Schema in
`packages/contracts`, stored as its kind and a JSON payload, so a new kind needs no migration. Each
kind carries what it was done to, such as the PR and its Revision or the To-do, so every feature's
Activity shares the one log without fitting a PR-shaped envelope.

The log is the source of truth and holds no search index. Full-text or vector search is a derived
index built from it when a reader exists, and can be rebuilt or replaced without touching the log.

## Considered Options

- **Append-only JSONL file**: simplest, but every future query becomes a full scan in our own code.
- **Postgres with pgvector**: a server to install and run beside a desktop app.

## Consequences

The backend records opening a PR workspace before returning a successful `OpenPullRequest`
response, using the PR, title, and Revision it just fetched. Reload uses the same flow. This makes
the PR resumable when the renderer receives it, without a second RPC or a navigation wait.
The renderer records file views, Reviews, and Replies through `RecordActivity` after those actions
succeed. The backend records adding a To-do and marking one done as part of saving the change. The backend stamps the time and the Connection login. Recording is best-effort: a failure
is logged, never shown, and does not turn a successful PR open into a failure.
