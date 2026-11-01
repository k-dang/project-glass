# Permission requests and Questions

A local Claude Code Agent has a Permission mode (Default, Accept edits, Auto, Bypass), chosen in New Agent and changeable from the composer. When the Agent wants to run something its mode doesn't allow, an "Allow <tool>?" card shows the tool and its input, to Allow, or Deny with an optional reason. A Question card shows the Agent's question with options and a box for the user's own words. While a card waits, the Agents list marks the Agent "Waiting on you" and the composer reads "Answer the Permission request above first". Stop ends the Turn "Stopped after …" and the card reads "No longer answerable: its Turn ended."

## Sub-features

- `request-allow` and `request-deny` answer a Permission request, and the Turn goes on.
- `question-answer` answers a Question with an option or the user's own words.
- `request-waiting` marks the Agent in the Agents list and blocks the composer while a card waits.
- `request-stop` stops the Turn while a card waits, leaving the card no longer answerable.
- `permission-mode` picks the mode in New Agent and changes it from the composer.

## How to get to it (user POV)

- Choose Agents in the left icon rail; New Agent opens with the composer.
- Open the program chip (it starts as `pi: gpt-test`) and choose Claude Code; the Permission mode chip reads Default.
- Send a message asking for a command in backticks, such as ``Please run `touch notes.txt` ``, or one containing "ask" for a Question.

## Driving it with glass-verify

Preconditions:

- `node $V launch --backend fake`. `pnpm dev:fake`'s backend runs Claude Code Agents on the real `claude` the pinned SDK ships, against its own fake Anthropic API and Claude config, so no model is called and nothing is charged.

- **Start a Claude Code Agent.** `click --role link --name "Agents"`, `wait --text "Local"`, `click --role button --name "pi: gpt-test"`, `click --role button --name "Claude Code"`, `press --key Escape`.
- **A waiting Permission request (`request-waiting`).** `type --role textbox --name "Message" --text 'Please run `touch notes.txt`'`, `press --key Enter`, `wait --text "Allow Bash?"`, `wait --text "Waiting on you"`, and capture `card-waiting`.
- **Allow or Deny (`request-allow`, `request-deny`).** `click --role button --name "Allow"`, then `wait --text "The fake model saw"`; or type a reason into the card's "Why not?" box and `click --role button --name "Deny"`.
- **A Question (`question-answer`).** Send `Please ask me which files to read`, `wait --text "Which files should I look at?"`, click an option or type into "Or answer in your own words", then `click --role button --name "Answer"`.
- **Stop while a card waits (`request-stop`).** With a card waiting, `click --role button --name "Stop"`, `wait --text "Stopped after"`, `wait --text "No longer answerable"`, and capture `stopped`; `text` no longer contains "Waiting on you". A next message then runs and ends "Done in …".
- **Proof.** A snapshot and screenshot of each state, and `backend.log` in the evidence: one `messages` line per model call, naming the tool the fake asked for, shows the real CLI reached the fake.

## Gotchas

- The real CLI approves read-only commands such as `ls` itself, even in Default; ask for a command that changes something, such as `touch`, to get a card.
- The fake model only calls a tool for a command in backticks or a message containing "ask"; anything else gets "Fake reply to: …" and the Turn ends at once.
- The demo Agent the fake backend seeds is a pi Agent; Permission modes and cards need a new Claude Code Agent.
