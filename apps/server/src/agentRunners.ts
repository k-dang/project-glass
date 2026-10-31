import {
  type AgentEngine,
  type AgentRunnerIdentity,
  type EngineModels,
  type EngineSettings,
  type PiModel,
  runnerIdentity,
} from "@glass/contracts"
import {
  Array as Arr,
  Context,
  Effect,
  FileSystem,
  type JsonSchema,
  Layer,
  Option,
  Predicate,
  Result,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { ChildProcessSpawner } from "effect/process"
import { join } from "node:path"
import { type AgentFailure, agentFailure, runnerFailureReason } from "./agentFailure"
import { launchCommand } from "./processes"
import { ServerConfig } from "./ServerConfig"

type FileAccess = "none" | "read-only"

export interface AgentTask<A> {
  readonly subject: string
  readonly instructions: string
  readonly prompt: string
  readonly answer: Schema.Decoder<A>
  readonly files: "none" | { readonly readOnly: string }
}

export interface AgentRunner {
  readonly identity: AgentRunnerIdentity
  readonly run: <A>(task: AgentTask<A>) => Effect.Effect<A, AgentFailure>
}

const answerSchema = (answer: Schema.Decoder<unknown>): JsonSchema.JsonSchema => {
  const document = Schema.toJsonSchemaDocument(answer)

  return { ...document.schema, $defs: document.definitions }
}

/**
 * Every runner asks for the answer as text matching a schema sent with the prompt. pi has no
 * schema-constrained output, and Claude Code's `--json-schema` would put the schema in argv, where
 * endpoint security tools kill processes with long arguments.
 */
const promptWithSchema = (task: AgentTask<unknown>) =>
  `${task.prompt}\n\nOutput JSON Schema:\n${JSON.stringify(answerSchema(task.answer))}`

const unusableFailure = (name: string, subject: string, identity: AgentRunnerIdentity) =>
  agentFailure("unusable-output", `${name} returned an unusable ${subject}. Try again.`, identity)

const startFailure = (name: string) => (error: { readonly reason: unknown }) => {
  const missing = Predicate.isTagged(error.reason, "NotFound")

  return agentFailure(
    missing ? "not-installed" : "not-ready",
    missing ? `${name} is not installed.` : `${name} could not start. Check its installation.`,
  )
}

const claudeFlags = ["--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]

// `--restricted` confines the file tools to the working directory and skips the user's settings
// files, so their hooks never see the PR's files.
const claudeReadOnlyTools = ["--restricted", "--tools", "Read,Grep,Glob"]

const runnerStrategies = Effect.gen(function* () {
  const config = yield* ServerConfig
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem

  const workingDirectory = fs
    .makeTempDirectoryScoped({ prefix: "glass-agent-" })
    .pipe(
      Effect.mapError(() =>
        agentFailure("storage", "Couldn't prepare a directory for the agent. Try again."),
      ),
    )

  const execute = Effect.fnUntraced(function* (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    input = "",
  ) {
    const process = yield* spawner.spawn(
      launchCommand(command, args, {
        cwd,
        stdin: Stream.make(new TextEncoder().encode(input)),
        extendEnv: true,
      }),
    )

    const [stdout, stderr, code] = yield* Effect.all(
      [
        process.stdout.pipe(
          Stream.decodeText(),
          Stream.runCollect,
          Effect.map((parts) => parts.join("")),
        ),
        process.stderr.pipe(
          Stream.decodeText(),
          Stream.runCollect,
          Effect.map((parts) => parts.join("")),
        ),
        process.exitCode,
      ],
      { concurrency: "unbounded" },
    )

    return { stdout, stderr, code }
  }, Effect.scoped)

  const decodeClaude = Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        is_error: Schema.optional(Schema.Boolean),
        result: Schema.optional(Schema.String),
      }),
    ),
  )

  const runClaudeCode = (
    cwd: string,
    model: string,
    identity: AgentRunnerIdentity,
  ): AgentRunner["run"] =>
    Effect.fn("runClaudeCode")(function* <A>(task: AgentTask<A>) {
      const files =
        task.files === "none"
          ? { directory: cwd, tools: ["--tools", ""] }
          : { directory: task.files.readOnly, tools: claudeReadOnlyTools }

      const unusable = unusableFailure("Claude Code", task.subject, identity)

      const result = yield* execute(
        config.claudeCommand,
        ["-p", ...files.tools, ...claudeFlags, "--model", model, "--output-format", "json"],
        files.directory,
        `${task.instructions}\n\n${promptWithSchema(task)}`,
      ).pipe(
        Effect.mapError(() =>
          agentFailure("failed", "Claude Code could not start. Check your installation.", identity),
        ),
      )

      const envelope = Option.getOrNull(yield* decodeClaude(result.stdout).pipe(Effect.option))

      if (result.code !== 0 || envelope?.is_error)
        return yield* agentFailure(
          runnerFailureReason(`${result.stderr}\n${envelope?.result ?? ""}`),
          `Claude Code could not write the ${task.subject}. Check its login and model availability, then try again.`,
          identity,
        )

      if (envelope?.result === undefined) return yield* unusable

      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(task.answer))(
        envelope.result,
      ).pipe(Effect.mapError(() => unusable))
    })

  const claudeReady = Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ loggedIn: Schema.Boolean })),
  )

  const claudeRunner = Effect.fnUntraced(function* (models: EngineModels, access: FileAccess) {
    const model = models["claude-code"]
    const cwd = yield* workingDirectory

    const [status, help] = yield* Effect.all(
      [
        execute(config.claudeCommand, ["auth", "status", "--json"], cwd).pipe(Effect.result),
        execute(config.claudeCommand, ["--help"], cwd).pipe(Effect.result),
      ],
      { concurrency: "unbounded" },
    )

    if (Result.isFailure(status)) return yield* startFailure("Claude Code")(status.failure)

    const loginFailure = agentFailure(
      "not-ready",
      "Claude Code's login could not be verified. Run claude auth login.",
    )

    const ready = yield* claudeReady(status.success.stdout).pipe(
      Effect.mapError(() => loginFailure),
    )

    if (!ready.loggedIn || status.success.code !== 0) return yield* loginFailure

    if (
      Result.isFailure(help) ||
      help.success.code !== 0 ||
      [...claudeFlags, "--tools"].some((flag) => !help.success.stdout.includes(flag))
    )
      return yield* agentFailure(
        "not-ready",
        "Claude Code's required execution restrictions could not be verified. Update Claude Code and try again.",
      )

    const identity = runnerIdentity({ engine: "claude-code", models })

    if (access === "read-only" && !help.success.stdout.includes("--restricted"))
      return yield* agentFailure(
        "not-ready",
        "Claude Code can't be limited to reading the PR's code. Update it, then try again.",
        identity,
      )

    return { identity, run: runClaudeCode(cwd, model, identity) } satisfies AgentRunner
  })

  const piReadOnlyTools = ["--tools", "read,grep,find,ls"]

  // Everything pi would load beyond the model, Glass's prompt, and a task's read-only tools stays
  // off. The thinking level is left to pi's settings, which it fits to each model; a level a model
  // lacks fails the request.
  const piCliFlags = [
    "--offline",
    "--no-session",
    "--no-extensions",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
  ]

  // `--mode json` ends with an `agent_end` event carrying the conversation; its last message is
  // the model's answer after any tool calls.
  const decodePiCliEnd = Schema.decodeUnknownOption(
    Schema.fromJsonString(
      Schema.Struct({ type: Schema.Literal("agent_end"), messages: Schema.Array(Schema.Unknown) }),
    ),
  )

  const decodePiCliAnswer = Schema.decodeUnknownOption(
    Schema.Struct({
      stopReason: Schema.String,
      errorMessage: Schema.optional(Schema.String),
      content: Schema.Array(
        Schema.Union([
          Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
          Schema.Struct({
            type: Schema.String.check(Schema.makeFilter((type) => type !== "text")),
          }),
        ]),
      ),
    }),
  )

  const runPiCli = (
    cwd: string,
    selection: PiModel,
    identity: AgentRunnerIdentity,
  ): AgentRunner["run"] =>
    Effect.fn("runPiCli")(function* <A>(task: AgentTask<A>) {
      const failed = (reason: AgentFailure["reason"]) =>
        agentFailure(
          reason,
          `pi could not write the ${task.subject}. The provider's error is in Glass's backend log; check pi's login and model, then try again.`,
          identity,
        )

      // pi reads `--system-prompt` from a file when given a path. A file keeps the instructions
      // out of argv, where endpoint security tools may kill processes with long arguments.
      const instructions = join(cwd, "instructions.md")
      yield* fs
        .writeFileString(instructions, task.instructions)
        .pipe(
          Effect.mapError(() =>
            agentFailure("storage", "Couldn't prepare pi's instructions. Try again.", identity),
          ),
        )

      const files =
        task.files === "none"
          ? { directory: cwd, tools: ["--no-tools"] }
          : { directory: task.files.readOnly, tools: piReadOnlyTools }

      const result = yield* execute(
        config.piCommand,
        [
          "-p",
          "--mode",
          "json",
          ...piCliFlags,
          ...files.tools,
          "--provider",
          selection.provider,
          "--model",
          selection.modelId,
          "--system-prompt",
          instructions,
        ],
        files.directory,
        promptWithSchema(task),
      ).pipe(
        Effect.mapError(() =>
          agentFailure("failed", "pi could not start. Check its installation.", identity),
        ),
      )

      if (result.code !== 0) {
        yield* Effect.logWarning("The pi CLI exited with an error", result.code, result.stderr)

        return yield* failed(runnerFailureReason(result.stderr))
      }

      const answer = Arr.findLast(result.stdout.split("\n"), (line) => decodePiCliEnd(line)).pipe(
        Option.flatMap((end) => decodePiCliAnswer(end.messages.at(-1))),
      )

      const unusable = unusableFailure("pi", task.subject, identity)

      if (Option.isNone(answer)) return yield* unusable

      const { stopReason, errorMessage = "", content } = answer.value

      if (stopReason === "error" || stopReason === "aborted") {
        yield* Effect.logWarning("pi's provider rejected the request", identity.model, errorMessage)

        return yield* failed(runnerFailureReason(errorMessage))
      }

      if (stopReason !== "stop") return yield* unusable

      const text = content.flatMap((part) => ("text" in part ? [part.text] : [])).join("")

      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(task.answer))(text).pipe(
        Effect.mapError(() => unusable),
      )
    })

  const piCliRunner = Effect.fnUntraced(function* (models: EngineModels) {
    const cwd = yield* workingDirectory
    const selection = models["pi-cli"]
    const identity = runnerIdentity({ engine: "pi-cli", models })
    const { model } = identity

    const listed = yield* execute(
      config.piCommand,
      ["--offline", "--list-models", selection.modelId],
      cwd,
    ).pipe(Effect.mapError(startFailure("pi")))

    if (listed.code !== 0)
      return yield* agentFailure(
        "not-ready",
        "pi could not list its models. Check its installation.",
      )

    // The listing is a table of `provider  model  …` rows matching the search fuzzily.
    const available = listed.stdout
      .split("\n")
      .slice(1)
      .some((row) => row.trim().split(/\s+/, 2).join("/") === model)

    if (!available)
      return yield* agentFailure(
        "not-ready",
        `pi has no model ${model}. Run pi --list-models to see yours, then change it in Settings.`,
      )

    return { identity, run: runPiCli(cwd, selection, identity) } satisfies AgentRunner
  })

  const runners: Record<
    AgentEngine,
    (
      models: EngineModels,
      access: FileAccess,
    ) => Effect.Effect<AgentRunner, AgentFailure, Scope.Scope>
  > = {
    "claude-code": claudeRunner,
    "pi-cli": piCliRunner,
  }

  return Effect.fn("selectAgentRunner")(({ engine, models }: EngineSettings, access: FileAccess) =>
    runners[engine](models, access),
  )
})

export class AgentRunners extends Context.Service<
  AgentRunners,
  {
    readonly select: (
      settings: EngineSettings,
      access: FileAccess,
    ) => Effect.Effect<AgentRunner, AgentFailure, Scope.Scope>
  }
>()("@glass/server/AgentRunners") {
  static readonly layer = Layer.effect(
    AgentRunners,
    Effect.map(runnerStrategies, (select) => AgentRunners.of({ select })),
  )
}
