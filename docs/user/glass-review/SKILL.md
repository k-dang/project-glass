---
name: glass-review
description: Ask the user to read this folder's changes in the Glass Inbox, then act on their approval or feedback.
disable-model-invocation: true
---

# Glass review

Call Glass's `check_in` MCP tool with:

- `folder`: the absolute path of your working directory, or of the folder the user named.
- `baseRef`: only when the user names a base, such as the branch below yours in a stack.
- `summary`: a short first line saying what changed, then where the user should look first.

Pass a progress token so the call outlives your client's timeout while Glass waits.

## Act on the result

- **Feedback**: address every note and the message. Each note names a file, the side of the diff,
  a line range, and the code the user read there, which may have moved since. Then tell the user
  what you changed and stop. Don't check in again; the user runs this skill when they want to read
  the changes again.
- **Approved**: carry on. Notes and a message on an approval are guidance, not a request to revise.
- **NoChanges**: tell the user there was nothing to read, and stop.
- **TimedOut** or **Cancelled**: the user did not answer. This is not approval. Say so in one
  sentence and stop; don't start work. Their notes come back on the next Check-in.

If the tool fails, report its message to the user. If there is no `check_in` tool, Glass isn't
connected: point the user to Settings → Outside agents in Glass.
