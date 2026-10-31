# Tour runners reuse existing credentials through the Claude Code and pi CLIs

> These runners are now strategies behind the seam Tours share with Agent reviews (ADR 0006). The
> execution contract below is the Tour task's; Agent reviews also read a checkout (ADR 0005).

The reviewer chooses Claude Code or the pi CLI when writing a Tour. Claude Code runs through its
local authenticated CLI; the pi CLI runs the user's installed `pi`. Both reuse the user's existing
credentials without adding an API-key store or authentication setup to Glass. Plain function strategies keep execution outside the
Tour service, prompt, repair, storage, and UI.

Each run has the same execution contract:

- no tools or MCP servers;
- no saved session;
- a model resolved once and fixed for the job;
- a parsed answer validated against the Tour JSON schema;
- only the supplied PR material as model context.

## Pi CLI

The pi CLI runner runs `GLASS_PI_COMMAND` (default `pi`) with the provider and model ID saved for
it, so Tours can use any model the reviewer's own pi lists, including providers only a fork of pi
adds, such as a company LiteLLM gateway. pi reads its credentials and model configuration from
`~/.pi/agent` (or `PI_CODING_AGENT_DIR`).

Before reading the PR, check that `pi --offline --list-models` lists that exact provider and
model: pi otherwise warns and sends an unknown model ID to the provider anyway. Then run
`pi -p --mode json` with tools, extensions, MCP, skills, prompt templates, themes, context files,
project-local files, and session saving all off. The instructions go in a file in the runner's
temporary directory passed to `--system-prompt`, which pi reads as a path. Some endpoint
security tools kill processes with arguments over about 1,000 characters. Stdin carries the PR
material and schema. The thinking level is left to pi's settings, which pi fits to each model.

pi exits 0 even when the provider rejects the request, so read the last assistant message from
the final `agent_end` event. Map its `stopReason` and `errorMessage` to Tour failures without
exposing raw output or credentials, and reject truncated answers. Log the provider's message to the
backend log, where it stays out of the UI and still explains the failure.

## Considered options

- **Pi's SDK in a disposable worker process**: needs no installed `pi` and controls the model
  request directly, but it knows only upstream pi's providers, can't read a checkout for Agent
  reviews without tools of Glass's own, and needs its own build entry and process protocol. pi
  Agents already need the installed `pi` (ADR 0007), so Glass dropped it for the pi CLI.

## Claude Code and selection

Claude Code runs in an empty temporary directory through `GLASS_CLAUDE_COMMAND` (default
`claude`). Check its login and required restrictions before generation. Disable tools, MCP,
session persistence, and slash commands. Supply the shared instructions and the answer's schema
on stdin and validate the answer locally, as for Pi; Claude Code's `--json-schema` would put the
schema in argv, where endpoint security tools kill processes with long arguments. Glass doesn't use `--bare`, which cannot reuse the CLI's OAuth or
keychain credentials, so the user's global Claude Code settings and hooks still load.

Check only the requested runner and report its failure without probing or falling back to the
other runner. Keep the selected runner/model fixed until the job ends. Explicit retries resolve
the current choice and model again. The toggle defaults to Claude Code and is saved in
`settings.json`, because the same runner writes Tours in the background for queued PRs when that
setting is on; display the runner/model while writing.

Adapters implement `run(task) => Effect<Answer, AgentFailure>` and own invocation, parsing,
validation, interruption, and expected-error mapping; the Tour service translates `AgentFailure`
into Tour failures. Keep selection as plain functions without a provider registry or a separate
service per runner. The prompt module owns the Tour answer schema and instructions; the Tour
service does not construct or transport provider-specific generation instructions.
