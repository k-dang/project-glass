# Permission requests and Questions

A local Claude Code Thread has a Permission mode (Default, Accept edits, Auto, Bypass), chosen in New Thread and changeable from the composer. When the agent wants to run something its mode doesn't allow, an "Allow <tool>?" card shows the tool and its input, to Allow, or Deny with an optional reason. A Question doesn't stop the agent: it asks with Glass's `ask_user`, the Transcript shows "Asked: …", and the Question waits in the Inbox under Stopped on you, where Send answers starts a new Turn (or Steers a running one) that the Transcript shows as "Answered in the Inbox". While a card waits, the Threads list marks the Thread "Waiting on you" and the composer reads "Answer the Permission request above first". Stop ends the Turn "Stopped after …" and the card reads "No longer answerable: its Turn ended."

## Sub-features

- `request-allow` and `request-deny` answer a Permission request, and the Turn goes on.
- `question-answer` answers a Question from the Inbox with an option or the user's own words, or sets it aside.
- `request-waiting` marks the Thread in the Threads list and blocks the composer while a card waits.
- `request-stop` stops the Turn while a card waits, leaving the card no longer answerable.
- `permission-mode` picks the mode in New Thread and changes it from the composer.

## How to get to it (user POV)

- Choose Threads in the left icon rail; New Thread opens with the composer.
- Open the Agent harness chip (it starts as `pi: gpt-test`) and choose Claude Code; the Permission mode chip reads Default.
- Send a message asking for a command in backticks, such as ``Please run `touch notes.txt` ``, or one containing "ask" for a Question.

## Driving it with glass-verify

Preconditions:

- `node $V launch --backend fake`. `pnpm dev:fake`'s backend runs Claude Code Threads on the real `claude` the pinned SDK ships, against its own fake Anthropic API and Claude config, so no model is called and nothing is charged.

- **Start a Claude Code Thread.** `click --role link --name "Threads"`, `wait --text "Local"`; New Thread already picks `button "Claude Code: Opus"`. Its Permission mode starts at Auto, which runs commands without asking: `click --role combobox --name "Permission mode"`, then `click --role option --name Default`.
- **A waiting Permission request (`request-waiting`).** `type --role textbox --name "Message" --text 'Please run `touch notes.txt`'`, `press --key Enter`, `wait --text "Allow Bash?"`, `wait --text "Waiting on you"`, and capture `card-waiting`.
- **Allow or Deny (`request-allow`, `request-deny`).** `click --role button --name "Allow"`, then `wait --text "The fake model saw"`; or type a reason into `textbox "Why not? (optional)"` and `click --role button --name "Deny"`.
- **A Question (`question-answer`).** Send `Please ask me which files to read`, `wait --text "Asked: Which files should I look at?"` and `wait --text "Waiting in the Inbox"`. `click --role link --name "Inbox"`, click the Thread's option under Stopped on you, click an option, such as `click --role radio --name "Only the README The quickest overview"` (each radio's name includes its description), or type into "Or type an answer", then `click --role button --name "Send answers"`; the Thread's Transcript then shows `Answered in the Inbox`. `click --role button --name "Set aside"` instead drops it from the Inbox without a Turn.
- **Stop while a card waits (`request-stop`).** With a Permission request waiting, `click --role button --name "Stop"`, `wait --text "Stopped after"`, `wait --text "No longer answerable"`, and capture `stopped`; the Thread's own row in the Threads list no longer reads "Waiting on you" (two seeded Threads always do). A next message then runs and ends "Done in …".
- **Proof.** A snapshot and screenshot of each state, and `backend.log` in the evidence: one `messages` line per model call, naming the tool the fake asked for, shows the real CLI reached the fake.

## Gotchas

- The real CLI approves read-only commands such as `ls` itself, even in Default; ask for a command that changes something, such as `touch`, to get a card.
- The fake model only calls a tool for a command in backticks, a message containing "ask", or a message that is `call:<glass tool> <json input>`, such as `call:list_thread_places {}`, which calls that Glass tool; anything else gets "Fake reply to: …" and the Turn ends at once.
- The seeded `demo/claude-permission` and `demo/claude-question` already wait on you; start a new Claude Code Thread so the cards you drive are your own.
