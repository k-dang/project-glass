# Outside agents

An outside agent is a program Glass did not launch, such as Claude Code in a terminal. After you
approve it, it can read your pull requests, to-dos, and agents, start and message agents, start a
review, ask you a question, and check in: ask you to read the changes in a folder on this computer
and approve them or send feedback. Questions and Check-ins show up in the Inbox under Stopped on
you, under the app's name.

The sign-in is an OAuth authorization code with PKCE. Glass listens on this computer only, so the
approval page opens here and names the app and what it will be able to do. A token from that
approval works on the MCP endpoint for 30 days. It does not work as a conversation Glass launched,
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

Claude Code opens the approval page. Approve it, then the agent can call `ask_user` and
`check_in`. Answer in the Inbox.

`claude mcp login glass` is the sign-in step. If your Claude Code build uses a different command,
run `claude mcp --help` and use the login or authenticate command it lists for an HTTP server.

## What you are approving

Approving lets that app read your pull requests, to-dos, and agents, start and message agents,
start a review, ask you a question, and have Glass read the changes in any git folder on this
computer it names, for you to read in the Inbox, until the token expires or you disconnect it.
Approve only a sign-in you just started. The page says where Glass will send the approval. That address has to
be on this computer (`127.0.0.1`, `localhost`, or `[::1]`).

## Check in on an agent's changes

`check_in` is for reading what an agent changed before it carries on, the way you would read a pull
request. The agent names its folder; Glass reads the changes itself, against where the branch
forked from its default branch (or the `baseRef` the agent passes), including uncommitted and
untracked files. Glass freezes them as they are, so your notes always match the code you read.

Select the Check-in in the Inbox and choose **Read the changes** to open them on their own page.
Select lines in the diff to leave Feedback notes, then choose **Send feedback** for
the agent to change the code, or **Approve** for it to carry on. Notes on an approval go to the
agent as guidance. The agent waits up to an hour, or the time it asks for, at most two hours. If it
stops waiting before you answer, your notes stay with the folder and come back on its next
Check-in.

To ask for a Check-in yourself, copy the [`glass-review`](glass-review/SKILL.md) folder into your
agent's skills folder: `~/.claude/skills/` for Claude Code, then type `/glass-review`, or
`~/.agents/skills/` for pi, then type `/skill:glass-review`.
