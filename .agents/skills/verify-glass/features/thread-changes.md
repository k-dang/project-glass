# Thread changes

A local Thread's Changes view shows its worktree diff. The view keeps its Revision until Show latest, even when another Turn changes files. The user can leave Feedback notes on lines of it, kept beside their code across restarts and labelled as an older version after Show latest. Review feedback adds the notes to the Thread's message, which sends them with their code as one message, or queues it while a Turn runs. Canceling queued feedback returns its notes to Changes.

## Sub-features

- Read a Thread's changes, return to Chat, and explicitly move to its latest changes.
- Select lines by keyboard, add a Feedback note, edit it in place, find it in the Feedback tab after a relaunch, see it marked Older version with its code after Show latest, and remove it.
- Review feedback, send it to the idle Thread, and queue more while a Turn runs.
- Cancel queued feedback, find its note back in Changes, edit it, and send it again.

## How to get to it (user POV)

Open a Thread and choose Changes in its Details. On a window at least 1200px wide they float as a card over the Chat's top-right corner; elsewhere, and on narrower windows, they sit behind the Details button, which also offers Back to Chat.

## Driving it with glass-verify

1. `node $V launch --backend fake`, doctor, and snapshot. Choose the Threads rail link, then `demo/look-around`. `wait --text README`.
2. Snapshot and screenshot `chat-before`. `type --role textbox --name Message --text "Write a note"`, `press --key Enter`, then `wait --text "hello from the agent"`. Snapshot the transcript and confirm the latest bash tool is marked Done before opening Changes. This exact demo message makes the real pi CLI write notes.txt using the shared E2E command fixture, with no model call.
3. `click --role button --name "Changes Ctrl+D"` in the floating Details (the item's name includes its shortcut, `⌘D` on macOS), `wait --text "hello from the agent"`. Snapshot and screenshot `thread-changes`.
4. Click `Details`, then `Back to Chat Ctrl+D`. Send `Write another` in Message. `wait --text "a second note"`, snapshot and confirm the latest bash tool is Done, then `Changes Ctrl+D`.
5. `wait --text "worked since you opened these changes"`. Snapshot and screenshot `held-changes`: more.txt is absent. `click --role button --name "Show latest"`, `wait --text "a second note"`, then snapshot and screenshot `latest-changes`. Both files appear. Stop.

Feedback notes, from step 3's Changes:

1. `click --role StaticText --name "hello from the agent"`, `press --key ArrowDown --shift`, `wait --text "New line 1"`. Click `Add feedback`, `type --role textbox --name "Feedback on selected code" --text ...`, click `Add note`, and `wait` for the text. Snapshot: `article "Feedback on notes.txt New line 1"` under the line, `tab "Feedback 1"`, Files still selected.
2. Click `Edit`, type new text, click `Save changes`, `wait` for it.
3. Run `kill-backend` four times, each once `doctor` shows Backend health OK again, then `wait --text "keeps stopping"` and click `Relaunch Glass`. Reopen the Thread's Changes and the `Feedback 1` tab: the edited note is there, without an Older version label.
4. Run step 4 above, then `Show latest` and `wait --text "older version"`. The note shows `Older version` with `hello from the agent` as its code, and the diff shows `View feedback`. Click `Remove`, `wait --text "No feedback yet"`.

Sending feedback, from a note added in Changes:

1. Click `Review feedback`. Chat opens; `wait --text "attached to this message"`. Type an instruction in Message, screenshot, and click `Send`. `wait --text "1 Feedback note"`: the demo Thread's reply quotes the `<glass_feedback>` block it received, with the note's code, and the note is gone from Changes.
2. Send `Please work slowly` (about 17s of reply), then at once add another note in Changes, click `Review feedback` and `Send`. `wait --text "Starts when the agent finishes"` and screenshot the Queued message. `wait --text "All done"`, then the queued feedback starts its own Turn.
3. To cancel it in time, queue it behind two slow messages: send `Please work slowly`, then `Please work slowly again`, then add a note, click `Review feedback` and `Send`. Type something in Message and click `Cancel: Feedback on the Thread's changes`: the typed text stays. In Changes the note is back under its line; `Edit` it, `Review feedback`, and `Send`. The reply quotes the edited note.

## Gotchas

- The demo backend writes files only for the two exact messages in `demoReply` (`apps/server/test/demoThread.ts`), as in `apps/desktop/e2e/threadChanges.test.ts`, and in the long Thread in `apps/server/test/demoLongThread.ts`. Other demo messages do not write files.
- These steps need a window at least 1200px wide (`launch` opens one at 1280px), so Details float over the Chat in `complementary "Details"`. They fall back to the `Details` button in Changes and while a Diagram or file pane is open; `Hide details` in the header hides them.
- The first Changes view is deliberately pinned; returning to Chat does not refresh it.
- Line numbers aren't buttons in the accessibility tree, so select lines with `press --shift` from a clicked code line rather than by clicking a number.
- Any change to the Thread's files marks every earlier note Older version, even on a file that didn't change.
