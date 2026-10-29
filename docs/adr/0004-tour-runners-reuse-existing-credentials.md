# Tour runners reuse existing credentials through Claude Code's CLI and Pi's SDK and CLI

> These runners are now strategies behind the seam Tours share with Agent reviews (ADR 0006). The
> execution contract below is the Tour task's; Agent reviews also read a checkout (ADR 0005).

The reviewer chooses Claude Code, pi, or the pi CLI when writing a Tour. Claude Code runs through
its local authenticated CLI; pi uses the official `@earendil-works/pi-coding-agent` SDK's
`ModelRuntime` in a disposable child process for each job; the pi CLI runs the user's installed
`pi`. All reuse the user's existing credentials without adding an API-key
store or authentication setup to Glass. Plain function strategies keep execution outside the
Tour service, prompt, repair, storage, and UI.

Each run has the same execution contract:

- no tools or MCP servers;
- no saved session;
- a model resolved once and fixed for the job;
- a parsed answer validated against the Tour JSON schema;
- only the supplied PR material as model context.

## Pi SDK

Tours need one model completion, so use `ModelRuntime.completeSimple()` rather than creating an
agent session. The SDK reads Pi's `auth.json`, `models.json`, and cached model catalog from its
usual agent directory (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`). This preserves API-key and OAuth
resolution, token refresh, environment credentials, and custom provider/model configuration.
Glass does not copy credentials or promise subscription billing for every provider.

Create a fresh SDK process for each job so external login and model configuration changes apply on retry.
Refresh only the selected provider from its local catalog and check that model's authentication
before reading the PR. Pass Glass's system prompt, PR material, and schema directly to the SDK
with an empty tool list. No agent resource loader, extensions, skills, prompt templates, context
files, user system prompts, compaction, cache warming, or session persistence participate.

Pi resolves command-backed credentials synchronously and caches their results for the process
lifetime. Keeping that work in a disposable process prevents it from blocking backend RPCs and
resets successful and failed helper lookups between jobs. Effect owns the process scope: cancel,
replacement, timeout, and backend shutdown terminate the worker and its helper process tree,
with forced termination after a short grace period on POSIX. Disable provider retries, reject
failed or truncated completions, and map provider errors to safe Tour failures without exposing
raw output or credentials. Pi returns text rather than schema-constrained output, so include
the schema in the prompt and validate the answer locally before shared file-coverage repair.

The SDK ships with Glass; no installed Pi executable or CLI-version probe is needed to generate
a Tour. Pi's CLI can still manage the credentials used by the SDK. Integration tests exercise
the real SDK against a local provider with isolated credential and model files.

The worker is a separate build entry shipped beside the backend. A private pipe reports validated
readiness or an expected failure before the backend reads the PR; stdin then carries one task's
instructions and prompt, and stdout pi's answer message, which the backend reads exactly as it
reads the pi CLI's. Empty input is rejected. Raw stderr is discarded.
Source integration tests build and launch the same worker entry as the desktop app.

## Pi CLI

The bundled SDK only knows upstream pi's providers. A fork of pi can add its own, such as a
company LiteLLM gateway, which only that fork's installed CLI can reach. The pi CLI runner runs
`GLASS_PI_COMMAND` (default `pi`) with the provider and model ID saved for it, so Tours can use any
model the reviewer's own pi lists.

Before reading the PR, check that `pi --offline --list-models` lists that exact provider and
model: pi otherwise warns and sends an unknown model ID to the provider anyway. Then run
`pi -p --mode json` with tools, extensions, MCP, skills, prompt templates, themes, context files,
project-local files, and session saving all off. The instructions go in a file in the runner's
temporary directory passed to `--system-prompt`, which pi reads as a path. Some endpoint
security tools kill processes with arguments over about 1,000 characters. Stdin carries the PR
material and schema as for the SDK. The thinking level is left to pi's settings, which pi fits
to each model.

pi exits 0 even when the provider rejects the request, so read the last assistant message from
the final `agent_end` event. Map its `stopReason` and `errorMessage` to Tour failures the same
way as the SDK. Log the provider's message to the backend log, where it stays out of the UI and
still explains the failure.

## Considered options

- **Only the Pi CLI**: reaches every provider of the installed pi, but requires an installed
  compatible executable and parses its event stream. The SDK needs no install and gives direct
  control over the model request, so both stay available.
- **SDK inside the backend**: smaller invocation boundary, but synchronous credential helpers
  block unrelated RPCs and cannot be interrupted by an AbortSignal. Module-level credential
  caches also outlive individual runtimes and keep stale or failed lookups until restart.
- **Pi agent session**: useful for tool execution and conversations; unnecessary for one
  completion with an explicit context and no tools.
- **Pi durable**: its experimental harness persists conversations and unfinished work for crash
  recovery. Tours already save completed results in SQLite and discard unfinished jobs on
  restart. A second persistence and task lifecycle adds no required behavior to this flow.

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
