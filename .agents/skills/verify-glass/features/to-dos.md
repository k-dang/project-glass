# To-dos

The To-dos rail area holds the user's own to-do list, kept on this device and never sent to GitHub. Open to-dos are listed in the order they were added, followed by an input to add one. Each row has a checkbox named after its title, its notes beneath, and Edit and Delete buttons. Edit swaps the row for Title and Notes fields with Save and Cancel. Checking a to-do moves it into a collapsed "Done (n)" section, struck through; unchecking it there reopens it. Delete removes a to-do without asking. With no open to-dos the list reads "Nothing to do.", and a failed load or save shows a "Couldn't access your to-dos" alert.

## Sub-features

- `todo-add` adds a to-do from the input; surrounding spaces are trimmed and the input clears.
- `todo-edit` saves a changed title and notes, Cancel keeps the to-do as it was, and an unfinished edit survives switching to another area and back.
- `todo-done` checks the box and strikes through the title immediately, keeping the row in place for at least 250 ms before a successful completion moves it into Done. A failed save restores the unchecked row and shows an error. Unchecking a to-do in Done moves it back to the open list in its original place. A successful save confirms "To-do completed" or "To-do reopened" in a toast with the to-do's title.
- `todo-delete` removes a to-do at once.
- `todo-persist` keeps to-dos, with their notes and done state, when the backend restarts.

## How to get to it (user POV)

- Choose To-dos in the left icon rail.
- Type in "Add a to-do" and press Enter or choose Add.
- Choose the pencil (Edit) or trash (Delete) on a row, or tick its checkbox.
- Expand "Done (n)" to see completed to-dos.

## Driving it with glass-verify

Preconditions:

- A fresh run; to-dos never call GitHub, so `node $V launch --github fake` avoids needing credentials. `node $V doctor` passes.

- **Empty list.** `node $V click --role link --name "To-dos"`, `node $V wait --text "Nothing to do."`, then `snapshot`/`screenshot` `todos-empty`.
- **Add (`todo-add`).** `node $V type --role textbox --name "New to-do" --text "Follow up on #42"`, `node $V click --role button --name "Add"`, `node $V wait --text "Follow up on #42"`. Add a second, "Delete me", the same way. The snapshot shows `list "Open to-dos"` with both rows in that order, and `textbox "New to-do"` is empty.
- **Edit (`todo-edit`).** `node $V click --role button --name "Edit Follow up on #42"`, `type --role textbox --name "Notes" --text "After CI passes"`, capture `todos-editing`, then `click --role button --name "Save"` and `wait --text "After CI passes"`. For Cancel, open Edit again, `type --role textbox --name "Title" --text "Discarded"`, choose `button "Cancel"`, and confirm `node $V text` has no "Discarded". For an unfinished edit, open Edit, type new notes, choose Settings, then To-dos: the editor is still open with the typed notes.
- **Delete (`todo-delete`).** `node $V click --role button --name "Delete Delete me"`; `node $V text` no longer has "Delete me".
- **Done and reopen (`todo-done`).** `node $V click --role checkbox --name "Follow up on #42"`, `wait --text "To-do completed"`, and capture `todos-completed` before the toast dismisses: it names the to-do, "Done (1)" appears, and the open list reads "Nothing to do.". `node $V click --role DisclosureTriangle --name "Done (1)"` and capture `todos-done`: `list "Done to-dos"` holds the struck-through row. Tick its checkbox again, `wait --text "To-do reopened"`, and capture `todos-reopened` before the toast dismisses: the to-do is back in the open list with "Done (1)" gone.
- **Persistence (`todo-persist`).** With a to-do that has notes and one in Done, reach Relaunch as in [`app-lifecycle.md`](app-lifecycle.md)'s crash-and-relaunch recipe and `click --role button --name "Relaunch Glass"`. Once the window is back on Reviews, choose To-dos and `wait --text "Done (1)"`. The open to-do still shows its notes; capture `todos-persisted`.
- **Proof.** Before/after snapshots and screenshots of each state above. `fake-github.log` has no to-do traffic, only the startup `GET /user`.

## Gotchas

- Each `launch` starts with an empty list, because every run has its own home. Prove `todo-persist` with Relaunch inside one run, not with a second `launch`.
- Relaunch opens Reviews, not To-dos; navigate back before asserting.
- "Done (n)" starts collapsed and its rows are absent from the snapshot until it is expanded. Its accessible role is `DisclosureTriangle`, not `group`.
- `type` pastes without pressing a key, so submit with `button "Add"` and close an edit with Save or Cancel. Enter-to-add and Escape-to-cancel need a raw CDP `Input.dispatchKeyEvent`.
- Row buttons are named "Edit <title>" and "Delete <title>", and the checkbox is named the title alone. Choose titles that don't overlap with others in the list.
- The brief checked state needs a recording or raw CDP capture within 250 ms of the click; separate helper commands can miss it. The row waits for both the save and this feedback interval; a slow save adds no further delay.
