# Feedback notes on a page

A Thread's HTML file opens in a File pane beside the Chat. The user selects text in the page, or turns on Pick element and clicks part of it, and leaves a Feedback note in an editor over the page. Each note is pinned on the page, numbered, and attached to the next message at once. Sending the message delivers the notes with what each points at, and their pins leave the page.

## Sub-features

- Pick element: hover outlines and names the part of the page; a click opens the note editor on it instead of reaching the page.
- Selecting text shows Add Feedback note beside the selection.
- Saved notes show as numbered pins and in the composer's Feedback attached to this message.
- Sending delivers a `<glass_feedback>` block of page notes, and the pins leave the page.

## How to get to it (user POV)

Open a Thread whose agent named an `.html` file in inline code, and click that path once the Turn ends. The File pane's toolbar reads "Select text, or pick an element, to leave a Feedback note." with a Pick element button.

## Driving it with glass-verify

1. `node $V launch --backend fake`, doctor. Open Threads, then `click --role link --name demo/artifacts`. `wait --text "proposed one stays"`.
2. `click --role button --name "the plan"`, `wait --text "pick an element"`. Screenshot.
3. Click `Pick element`, `wait --text "Click part of the page"`. Move the mouse over the table's `5` cell and click it (see Gotchas), then `wait --text "Add feedback"`. Snapshot: `form "Add Feedback note"` names `Table cell · Token bucket × Refill / min`.
4. `type --role textbox --name "Feedback on the selected part of the page" --text "Make this ten"`, `press --key Enter --meta`, `wait --text "attached to this message"`. Screenshot: pin 1 on the cell.
5. Click `Pick element` again to turn it off, drag across "refill of five per minute" in the page, click `Add Feedback note` beside it, write and save a second note. `wait --text "2 Feedback notes attached"`.
6. Type a message, `press --key Enter`, `wait --text "2 Feedback notes"`. Screenshot: the pins are gone. The demo agent's reply quotes the `<glass_feedback>` block with each note's selector and text.

## Gotchas

- The page runs in its own sandboxed frame, outside the window's accessibility tree, so `click` and `snapshot` can't reach inside it. Drive the page with raw CDP `Input.dispatchMouseEvent` (`mouseMoved`, `mousePressed`, `mouseReleased`) on the page target from `http://127.0.0.1:<port>/json/list`, at points read off a screenshot.
- The note editor saves on ⌘Enter / Ctrl+Enter; plain Enter adds a line.
