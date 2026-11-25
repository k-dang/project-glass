# Outside agents

An outside agent is a program Glass did not launch, such as Claude Code in a terminal. After you
approve it, it can read your pull requests, to-dos, and agents, start and message agents, start a
review, ask you a question, and check in: ask you to read the changes in a folder on this computer
and approve them or send feedback. Questions and Check-ins show up in the Inbox under Stopped on
you, under the app's name.

The sign-in is an OAuth authorization code with PKCE. Glass listens on this computer only, so the
sign-in page opens here, in your browser, and asks you to answer in Glass. Glass shows the request
in the Inbox under Stopped on you, with the app's name and what it will be able to do. Only Glass's
window can approve it: any program on this computer can open the sign-in page, so the page itself
has no Approve button. Once you answer, the page sends your answer back to the app. A token from
that approval works on the MCP endpoint for 30 days. It does not work as a Thread Glass launched,
and it does not work on any other Glass route. Disconnect it in Settings → Outside agents.

## Connect Claude Code

Glass shows the MCP address in Settings → Outside agents. It looks like
`http://127.0.0.1:<port>/mcp`. Glass remembers that port and uses it again the next time it starts.
The address changes only when something else is already listening on the remembered port. In a
terminal:

```sh
claude mcp add --transport http glass http://127.0.0.1:<port>/mcp
claude mcp login glass
```

Claude Code opens the sign-in page in your browser. Approve the request in Glass's Inbox, then the
agent can call `ask_user` and `check_in`. Neither waits for you: each returns an id at once, and you
answer in the Inbox, now or days later, or set it aside. The agent reads your answer with
`read_answer` and that id, from any of its sessions; Glass doesn't wake it, so tell it when you've
answered. A new session that doesn't have the id calls `list_answers`, which lists the questions
and Check-ins whose answer the agent hasn't read yet.

`claude mcp login glass` is the sign-in step. If your Claude Code build uses a different command,
run `claude mcp --help` and use the login or authenticate command it lists for an HTTP server.

## What you are approving

Approving lets that app read your pull requests, to-dos, and agents, start and message agents,
start a review, ask you a question, and have Glass read the changes in any git folder on this
computer it names, for you to read in the Inbox, until the token expires or you disconnect it.
Approve only a sign-in you just started. The request says where Glass will send the approval. That
address has to be on this computer (`127.0.0.1`, `localhost`, or `[::1]`). A request you leave
unanswered ends after 10 minutes.

## Check in on an agent's changes

`check_in` is for reading what an agent changed before it carries on, the way you would read a pull
request. The agent names its folder; Glass reads the changes itself, against where the branch
forked from its default branch (or the `baseRef` the agent passes), including uncommitted and
untracked files. Glass freezes them as they are, so your notes always match the code you read.

When a Check-in arrives, Glass comes to the front on its page. Check-ins already waiting when Glass
starts stay in the Inbox: select one and choose **Read the changes** to open them on their own page.
Select lines in the diff to leave Feedback notes, then choose **Send feedback** for
the agent to change the code, or **Approve** for it to carry on, or **Set aside** in the Inbox to
answer neither. Notes on an approval go to the agent as guidance. A Check-in waits until you answer
it, across restarts. If the agent checks in again from the same folder first, the new Check-in
replaces the old one and your notes carry over to it.

To ask for a Check-in yourself, copy the [`glass-review`](glass-review/SKILL.md) folder into your
agent's skills folder: `~/.claude/skills/` for Claude Code, then type `/glass-review`, or
`~/.agents/skills/` for pi, then type `/skill:glass-review`. Once you've answered in the Inbox, tell
the agent; it reads your answer, and after Feedback addresses it and stops. Run the skill again when
you want to read the new changes.
