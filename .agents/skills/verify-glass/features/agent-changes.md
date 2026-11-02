# Agent changes

A local Agent's Changes view shows its worktree diff. The view keeps its Revision until Show latest, even when another Turn changes files.

## Sub-features

- Read an Agent's changes, return to Chat, and explicitly move to its latest changes.

## How to get to it (user POV)

Open an Agent, choose Details, then Changes. Details also offers Back to Chat.

## Driving it with glass-verify

1. `node $V launch --backend fake`, doctor, and snapshot. Choose the Agents rail link, then the seeded Agent link under Local from the snapshot (its generated name varies). `wait --text README`.
2. Snapshot and screenshot `chat-before`. `type --role textbox --name Message --text "Write a note"`, `press --key Enter`, then `wait --text "hello from the Agent"`. Snapshot the transcript and confirm the latest bash tool is marked Done before opening Changes. This exact demo message makes the real pi CLI write notes.txt using the shared E2E command fixture, with no model call.
3. `click --role button --name Details`, `click --role button --name Changes`, `wait --text "hello from the Agent"`. Snapshot and screenshot `agent-changes`.
4. Choose Details then Back to Chat. Send `Write another` in Message. `wait --text "a second note"`, snapshot and confirm the latest bash tool is Done, then Details and Changes.
5. `wait --text "worked since you opened these changes"`. Snapshot and screenshot `held-changes`: more.txt is absent. `click --role button --name "Show latest"`, `wait --text "a second note"`, then snapshot and screenshot `latest-changes`. Both files appear. Stop.

## Gotchas

- The two exact messages reuse `runCommands` from `apps/server/test/fakeModelProvider.ts`, as in `apps/desktop/e2e/agentChanges.spec.ts`. Other demo messages do not write files.
- Capture snapshots before selecting Details menu items; target their accessible roles and names.
- The first Changes view is deliberately pinned; returning to Chat does not refresh it.
