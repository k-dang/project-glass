# Outside agents

An outside agent is a program Glass did not launch, such as Claude Code in a terminal. After you
approve it, it can use Glass's MCP tools on this computer, including asking you a question. The
question shows up in the Inbox under Stopped on you.

The sign-in is an OAuth authorization code with PKCE. Glass listens on this computer only, so the
approval page opens here and names the app. A token from that approval works on the MCP endpoint
for 30 days. It does not work as a conversation Glass launched, and it does not work on any other
Glass route. Revoke it in Settings → Outside agents.

## Connect Claude Code

Glass shows the MCP address in Settings → Outside agents. It looks like
`http://127.0.0.1:<port>/mcp`. In a terminal:

```sh
claude mcp add --transport http glass http://127.0.0.1:<port>/mcp
claude mcp login glass
```

Claude Code opens the approval page. Approve it, then the agent can call `ask_user`. Answer in
the Inbox.

`claude mcp login glass` is the sign-in step. If your Claude Code build uses a different command,
run `claude mcp --help` and use the login or authenticate command it lists for an HTTP server.

## What you are approving

Approving lets that app call Glass's MCP tools until the token expires or you revoke it. Approve
only a sign-in you just started. The page says where Glass will send the approval. For an agent
on this computer, that is a loopback address.
