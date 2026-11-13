# Outside agents

An outside agent is a program Glass did not launch, such as Claude Code in a terminal. After you
approve it, it can read your pull requests, to-dos, and agents, start and message agents, start a
review, and ask you a question. The question shows up in the Inbox under Stopped on you, under the
app's name.

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

Claude Code opens the approval page. Approve it, then the agent can call `ask_user`. Answer in
the Inbox.

`claude mcp login glass` is the sign-in step. If your Claude Code build uses a different command,
run `claude mcp --help` and use the login or authenticate command it lists for an HTTP server.

## What you are approving

Approving lets that app read your pull requests, to-dos, and agents, start and message agents,
start a review, and ask you a question, until the token expires or you disconnect it. Approve only
a sign-in you just started. The page says where Glass will send the approval. That address has to
be on this computer (`127.0.0.1`, `localhost`, or `[::1]`).
