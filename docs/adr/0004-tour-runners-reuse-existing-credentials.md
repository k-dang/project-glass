# Tour runners reuse existing credentials through the Claude Code and pi CLIs

> These runners are now strategies behind the seam Tours share with Agent reviews (ADR 0006), and
> Agent reviews also read a checkout (ADR 0005). Tours now read one too (ADR 0012), so the paragraph
> below on running with no tools no longer holds.

The reviewer chooses Claude Code or the pi CLI when writing a Tour. Both reuse the user's existing
credentials through their installed CLI, so Glass adds no API-key store or authentication setup, and
Tours can use any model the user's own pi lists, including providers only a fork of pi adds, such as
a company LiteLLM gateway.

Each run gets only the supplied PR material as context, with no tools, MCP servers, or saved
session, and Glass validates the answer against the Tour schema itself. Glass checks only the
requested runner and reports its failure rather than falling back to the other, so a Tour never
quietly comes from a model the user didn't choose.

Three constraints of these CLIs shape the runners and aren't obvious from their documentation:

- Some endpoint security tools kill processes with arguments over about 1,000 characters, so
  instructions, PR material, and schemas stay out of argv. That rules out Claude Code's
  `--json-schema`.
- pi exits 0 even when the provider rejects the request, so success comes from its final message,
  not its exit code. An unknown model ID also only warns, so Glass checks the model against pi's
  list first.
- Claude Code's `--bare` can't reuse the CLI's OAuth or keychain credentials, so Glass doesn't use
  it, and the user's global Claude Code settings and hooks still load.

## Considered options

- **Pi's SDK in a disposable worker process**: needs no installed `pi` and controls the model
  request directly, but it knows only upstream pi's providers, can't read a checkout for Agent
  reviews without tools of Glass's own, and needs its own build entry and process protocol. pi
  Agents already need the installed `pi` (ADR 0007), so Glass dropped it for the pi CLI.

## Revisit when

- Glass needs to work for users without either CLI installed.
- A CLI stops exposing what the runners need, such as restricted tools or a machine-readable result.
