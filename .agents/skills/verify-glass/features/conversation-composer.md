# Conversation composer

A Conversation's composer keeps working while its Turn runs. Sending then Queues the message in a list above the composer headed "Starts when the agent finishes"; Queued messages start in order as Turns end. ⌘Enter (Ctrl+Enter too) Steers the running Turn instead: the message shows in the Turn under "Steered" where the agent took it in. While the Turn runs each Queued message offers only Cancel. Stop (the square button) ends the Turn "Stopped after …" and leaves the Queued messages "Waiting until you send them", each with Send now and Cancel; Steers the agent hadn't taken in come back first. Images can be pasted or dropped into a message, ↑ in an empty composer recalls the last message, and unsent text survives switching Conversations.

## Sub-features

- `composer-queue` Queues messages sent while a Turn runs and starts them in order as Turns end.
- `composer-steer` puts a ⌘Enter message into the running Turn, shown as a Steer.
- `composer-stop` ends the Turn stopped, keeps the Queued messages waiting, and puts back an unsent Steer.
- `composer-send-now` and `composer-cancel` start or drop a waiting Queued message.

## How to get to it (user POV)

- Choose Conversations in the left icon rail, then a Conversation under Local.
- Type in the Message box and press Enter to send or Queue, or ⌘Enter to Steer.
- Hover a Queued message for its Send now (↑) and Cancel (✕) buttons.

## Driving it with glass-verify

Preconditions:

- `node $V launch --backend fake`: `pnpm dev:fake`'s backend, which seeds eight demo Conversations (five pi, three Claude Code) on its own fake GitHub and model provider. `node $V doctor` passes.

- **Open the demo Conversation.** `click --role link --name "Conversations"`, then the pi Conversation whose transcript starts "Show me around this repository." (names such as `agent/quiet-raven` are generated per run), and `wait --text "README"`.
- **A running Turn.** `type --role textbox --name "Message" --text "Write the greeting, slowly"`, `press --key Enter`, `wait --text "Step 1"`. The demo Conversation streams a message containing "slowly" over about 18 seconds.
- **Queue (`composer-queue`).** While it runs, `type` and `press --key Enter` twice more, `wait --text "Starts when the agent finishes"`, and capture `queued`. After the Turn, each Queued message starts as its own Turn, answered "Got it: …".
- **Steer (`composer-steer`).** In a new slow Turn, `type` a message and `press --key Enter --meta`, then `wait --text "Got it: “<message>”"` and capture `steered`: "Steered" sits over the message inside the Turn.
- **Stop (`composer-stop`).** In a new slow Turn, Queue one message, Steer another, `click --role button --name "Stop"`, `wait --text "Waiting until you send them"`, and capture `stopped`: the Turn reads "Stopped after …" and the Steer is the first Queued message.
- **Send now and Cancel.** `click --role button --name "Send now: <message>"` (only after Stop) or `"Cancel: <message>"`; Send now answers "Got it: “<message>”".
- **Proof.** A snapshot and screenshot of each state; `region "Queued messages"` in the snapshot lists the Send now and Cancel buttons that the screenshot shows only on hover.

## Gotchas

- Only a message containing "slowly", sent to a pi Conversation, keeps the demo Turn running; every other demo reply ends at once, so Queue, Steer, and Stop have nothing to act on.
- Send now and Cancel are hidden until hover; target them by name rather than by sight.
- `type` replaces the box's text without a key press, so send with `press --key Enter`.
- `--backend fake` brings its own fake GitHub, so it doesn't combine with `--github fake`.
