# Agent changes

A local Agent's Changes view shows its worktree diff. The view keeps its Revision until Show latest, even when another Turn changes files. The user can leave Feedback notes on lines of it, kept beside their code across restarts and labelled as an older version after Show latest. Review feedback adds the notes to the Agent's message, which sends them with their code as one message, or queues it while a Turn runs.

## Sub-features

- Read an Agent's changes, return to Chat, and explicitly move to its latest changes.
- Select lines by keyboard, add a Feedback note, edit it in place, find it in the Feedback tab after a relaunch, see it marked Older version with its code after Show latest, and remove it.
- Review feedback, send it to the idle Agent, and queue more while a Turn runs.

## How to get to it (user POV)

Open an Agent, choose Details, then Changes. Details also offers Back to Chat.

## Driving it with glass-verify

1. `node $V launch --backend fake`, doctor, and snapshot. Choose the Agents rail link, then the seeded Agent link under Local from the snapshot (its generated name varies). `wait --text README`.
2. Snapshot and screenshot `chat-before`. `type --role textbox --name Message --text "Write a note"`, `press --key Enter`, then `wait --text "hello from the Agent"`. Snapshot the transcript and confirm the latest bash tool is marked Done before opening Changes. This exact demo message makes the real pi CLI write notes.txt using the shared E2E command fixture, with no model call.
3. `click --role button --name Details`, `click --role button --name Changes`, `wait --text "hello from the Agent"`. Snapshot and screenshot `agent-changes`.
4. Choose Details then Back to Chat. Send `Write another` in Message. `wait --text "a second note"`, snapshot and confirm the latest bash tool is Done, then Details and Changes.
5. `wait --text "worked since you opened these changes"`. Snapshot and screenshot `held-changes`: more.txt is absent. `click --role button --name "Show latest"`, `wait --text "a second note"`, then snapshot and screenshot `latest-changes`. Both files appear. Stop.

Feedback notes, from step 3's Changes:

1. `click --role StaticText --name "hello from the Agent"`, `press --key ArrowDown --shift`, `wait --text "New line 1"`. Click `Add feedback`, `type --role textbox --name "Feedback on selected code" --text ...`, click `Add note`, and `wait` for the text. Snapshot: `article "Feedback on notes.txt New line 1"` under the line, `tab "Feedback 1"`, Files still selected.
2. Click `Edit`, type new text, click `Save changes`, `wait` for it.
3. Run `kill-backend` four times, each once `doctor` shows Backend health OK again, then `wait --text "keeps stopping"` and click `Relaunch Glass`. Reopen the Agent's Changes and the `Feedback 1` tab: the edited note is there, without an Older version label.
4. Run step 4 above, then `Show latest` and `wait --text "older version"`. The note shows `Older version` with `hello from the Agent` as its code, and the diff shows `View feedback`. Click `Remove`, `wait --text "No feedback yet"`.

Sending feedback, from a note added in Changes:

1. Click `Review feedback`. Chat opens; `wait --text "attached to this message"`. Type an instruction in Message, screenshot, and click `Send`. `wait --text "1 Feedback note"`: the demo Agent's reply quotes the `<glass_feedback>` block it received, with the note's code, and the note is gone from Changes.
2. Send `Please work slowly` (about 9s of reply), then at once add another note in Changes, click `Review feedback` and `Send`. `wait --text "Starts when the Agent finishes"` and screenshot the Queued message. `wait --text "All done"`, then the queued feedback starts its own Turn.

## Gotchas

- The two exact messages reuse `runCommands` from `apps/server/test/fakeModelProvider.ts`, as in `apps/desktop/e2e/agentChanges.spec.ts`. Other demo messages do not write files.
- Capture snapshots before selecting Details menu items; target their accessible roles and names.
- The first Changes view is deliberately pinned; returning to Chat does not refresh it.
- Line numbers aren't buttons in the accessibility tree, so select lines with `press --shift` from a clicked code line rather than by clicking a number.
- Any change to the Agent's files marks every earlier note Older version, even on a file that didn't change.
