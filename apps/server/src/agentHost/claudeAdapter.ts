import {
  type CanUseTool,
  type EffortLevel as SdkEffortLevel,
  getSessionInfo,
  type ModelInfo,
  type PermissionResult,
  type Query,
  query,
  type SDKControlInitializeResponse,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import {
  type AgentModel,
  AgentModels,
  QuestionPart,
  type QuestionReply,
  type RequestAnswer,
  RequestNotWaiting,
  type RequestPart,
  type SentMessage,
  sentOf,
} from "@glass/contracts"
import { Deferred, Effect, Option, Predicate, Queue, Schema, type Scope, Stream } from "effect"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import type { AgentAdapter } from "./adapter"
import { Input, isFailure, machine } from "./claudeTurn"
import { couldNotSwitch, HostAgentError, notRunning } from "./protocol"
import { settleWith } from "./requests"
import { permissionRequest, ToolInput } from "./toolCalls"
import { runTurns } from "./turnLoop"

const START_TIMEOUT = "60 seconds"

const effortLevels = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies ReadonlyArray<SdkEffortLevel>

const EffortLevel = Schema.NullOr(Schema.Literals(effortLevels))

const startFailure = (cause: unknown) =>
  new HostAgentError({
    message: /ENOENT|not found/i.test(String(cause))
      ? "Claude Code isn't installed. Install it, or point GLASS_CLAUDE_COMMAND at it."
      : "Claude Code could not start. Check its installation.",
  })

const startClaude = (
  command: string,
  folder: string,
  prompt: AsyncIterable<SDKUserMessage>,
  canUseTool: CanUseTool,
  sessionOption?: { readonly resume: string } | { readonly sessionId: string },
): Effect.Effect<
  { readonly session: Query; readonly initialized: SDKControlInitializeResponse },
  HostAgentError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const session = yield* Effect.acquireRelease(
      Effect.sync(() =>
        query({
          prompt,
          options: {
            pathToClaudeCodeExecutable: command,
            cwd: folder,
            // The SDK's own default system prompt is empty, unlike the terminal `claude`'s.
            systemPrompt: { type: "preset", preset: "claude_code" },
            includePartialMessages: true,
            ...sessionOption,
            canUseTool,
            // The user may pick bypassPermissions between Turns.
            allowDangerouslySkipPermissions: true,
            stderr: (data) => {
              if (data.trim() !== "")
                Effect.runFork(Effect.logWarning("claude wrote to stderr", data))
            },
          },
        }),
      ),
      (opened) => Effect.sync(() => opened.close()),
    )

    const initialized = yield* Effect.tryPromise(() => session.initializationResult()).pipe(
      Effect.timeoutOrElse({
        duration: START_TIMEOUT,
        orElse: () => Effect.fail("claude didn't answer the SDK's handshake"),
      }),
      Effect.tapError((cause) => Effect.logWarning("Claude Code could not start", cause)),
      Effect.mapError(startFailure),
    )

    return { session, initialized }
  })

const toModel = (info: ModelInfo): AgentModel => ({
  id: info.value,
  name: info.displayName,
  efforts: info.supportedEffortLevels ?? [],
})

const userMessage = ({ message, images }: SentMessage): SDKUserMessage => ({
  type: "user",
  message: {
    role: "user",
    content:
      images.length === 0
        ? message
        : [
            ...images.map(({ mediaType, data }) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: mediaType, data },
            })),
            { type: "text" as const, text: message },
          ],
  },
  parent_tool_use_id: null,
})

interface CancellingInterrupt {
  interrupt(options: { readonly cancelQueued: boolean }): ReturnType<Query["interrupt"]>
}

const interruptAll = (session: Query) =>
  Effect.tryPromise(async () => {
    // SAFETY: SDK 0.3.309's `interrupt` passes `{ cancelQueued: true }` on as the control request's
    // `cancel_queued`, which its types leave out. A CLI too old for it lists nothing as cancelled.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- See SAFETY above.
    const cancelling = session as unknown as CancellingInterrupt
    const receipt = await cancelling.interrupt({ cancelQueued: true })

    return receipt?.cancelled ?? []
  }).pipe(
    Effect.tapError((cause) => Effect.logWarning("Claude Code refused to stop", cause)),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  )

const control = (what: "model" | "effort" | "Permission mode", call: () => Promise<void>) =>
  Effect.tryPromise(call).pipe(
    Effect.tapError((cause) => Effect.logWarning(`Claude Code refused a ${what}`, cause)),
    Effect.mapError(() => couldNotSwitch("Claude Code", what)),
  )

const AskedQuestions = Schema.Struct({
  questions: Schema.Array(
    Schema.Struct({
      question: Schema.String,
      header: Schema.optional(Schema.String),
      options: Schema.Array(
        Schema.Struct({ label: Schema.String, description: Schema.optional(Schema.String) }),
      ),
      multiSelect: Schema.optional(Schema.Boolean),
    }),
  ),
})

const decodeQuestions = Schema.decodeUnknownOption(AskedQuestions)

const decodeToolInput = Schema.decodeUnknownOption(ToolInput)

/** What Claude Code asks before running a tool: AskUserQuestion asks the user a Question. */
const requestOf = (requestId: string, toolName: string, input: ToolInput) => {
  if (toolName === "AskUserQuestion") {
    const asked = decodeQuestions(input)

    if (Option.isSome(asked))
      return QuestionPart.make({
        requestId,
        questions: asked.value.questions.map((question) => ({
          header: question.header ?? null,
          question: question.question,
          detail: null,
          options: question.options.map(({ label, description }) => ({
            label,
            description: description ?? null,
          })),
          multiSelect: question.multiSelect ?? false,
          // Claude Code always offers its own words beside the options.
          freeText: true,
        })),
        status: "waiting",
        answers: null,
      })
  }

  return permissionRequest(requestId, toolName, input)
}

/** Claude Code reads a reply as text, with a multi-select question's labels joined by commas. */
const replyText = (reply: QuestionReply | undefined) =>
  reply?.text ?? reply?.chosen.join(", ") ?? ""

/**
 * What to tell Claude Code about a request the user settled. It reads a Question's answers from the
 * tool's input, keyed by question.
 */
const permissionResult = (settled: RequestPart, input: ToolInput): PermissionResult => {
  if (Predicate.isTagged(settled, "Question")) {
    const answers = settled.answers ?? []

    return {
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: Object.fromEntries(
          settled.questions.map(({ question }, index) => [question, replyText(answers[index])]),
        ),
      },
    }
  }

  return settled.status === "denied"
    ? { behavior: "deny", message: settled.reason ?? "The user denied this tool call." }
    : { behavior: "allow", updatedInput: input }
}

interface Asked {
  readonly part: RequestPart
  readonly input: ToolInput
  readonly answered: Deferred.Deferred<PermissionResult>
}

export const claudeAdapter = (command: string): AgentAdapter => ({
  models: Effect.gen(function* () {
    const { initialized } = yield* startClaude(
      command,
      homedir(),
      Stream.toAsyncIterable(Stream.never),
      // Listing models runs no tools.
      () => Promise.resolve({ behavior: "deny", message: "Glass is only listing models." }),
    )

    const { models } = initialized
    // Claude Code lists its default as a model called `default`, which a `null` model runs; it is
    // named after the model it resolves to.
    const fallback = models.find((model) => model.value === "default")
    const others = models.filter((model) => model !== fallback)

    const resolved = others.find(
      (model) =>
        fallback?.resolvedModel !== undefined && model.resolvedModel === fallback.resolvedModel,
    )

    return new AgentModels({
      defaultModel:
        fallback === undefined
          ? null
          : { ...toModel(fallback), name: resolved?.displayName ?? fallback.displayName },
      models: others.map(toModel),
    })
  }).pipe(Effect.scoped),

  start: Effect.fnUntraced(function* ({ folder, conversation, report }) {
    const prompts = yield* Queue.unbounded<SDKUserMessage>()
    const requests = yield* Queue.unbounded<Input>()
    const waiting = new Map<string, Asked>()

    const ask = (toolName: string, input: ToolInput, requestId: string) =>
      Effect.gen(function* () {
        const part = requestOf(requestId, toolName, input)
        const answered = yield* Deferred.make<PermissionResult>()
        waiting.set(requestId, { part, input, answered })
        yield* Queue.offer(requests, Input.Asked({ part }))

        return yield* Deferred.await(answered)
      }).pipe(
        Effect.onInterrupt(() => Queue.offer(requests, Input.Settled({ requestId, answer: null }))),
        Effect.ensuring(Effect.sync(() => waiting.delete(requestId))),
      )

    // Claude Code refuses to resume a conversation it hasn't saved, and to start one it has.
    const saved = yield* Effect.tryPromise(() =>
      getSessionInfo(conversation, { dir: folder }),
    ).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Couldn't look up a Claude Code conversation", cause),
      ),
      Effect.mapError(
        () =>
          new HostAgentError({
            message: "Glass couldn't look up this Agent's Claude Code conversation. Try again.",
          }),
      ),
    )

    const { session } = yield* startClaude(
      command,
      folder,
      Stream.toAsyncIterable(Stream.fromQueue(prompts)),
      (toolName, input, { toolUseID, signal }) =>
        Effect.runPromise(
          ask(
            toolName,
            Option.getOrElse(decodeToolInput(input), () => ({})),
            toolUseID,
          ),
          { signal },
        ),
      saved === undefined ? { sessionId: conversation } : { resume: conversation },
    )

    const turns = yield* runTurns({
      program: "Claude Code",
      machine,
      events: Stream.fromAsyncIterable(session, (cause) => cause).pipe(
        Stream.tap((message) =>
          isFailure(message)
            ? Effect.logWarning("Claude Code ended a Turn with an error", message)
            : Effect.void,
        ),
        Stream.map((message) => Input.Message({ message })),
        Stream.merge(Stream.fromQueue(requests), { haltStrategy: "left" }),
      ),
      report,
    })

    return {
      closed: turns.closed,
      stopped: turns.stopped,
      configure: Effect.fnUntraced(function* ({ model, effort, permissionMode }) {
        const effortLevel = yield* Schema.decodeUnknownEffect(EffortLevel)(effort).pipe(
          Effect.mapError(() => couldNotSwitch("Claude Code", "effort")),
        )

        yield* control("model", () => session.setModel(model ?? undefined))
        yield* control("effort", () => session.applyFlagSettings({ effortLevel }))

        if (permissionMode !== null)
          yield* control("Permission mode", () => session.setPermissionMode(permissionMode))
      }),
      startTurn: Effect.fnUntraced(function* (turnId: string, sent: SentMessage) {
        yield* turns.begin(turnId, sent)

        return yield* Queue.offer(prompts, { ...userMessage(sent), uuid: randomUUID() }).pipe(
          Effect.asVoid,
        )
      }),
      // Claude Code folds a message with priority `next` into the running Turn between tool rounds.
      steer: Effect.fnUntraced(function* (sent: SentMessage) {
        const uuid = randomUUID()

        if (!(yield* turns.steer({ ...sent, id: uuid }))) return yield* notRunning

        return yield* Queue.offer(prompts, { ...userMessage(sent), uuid, priority: "next" }).pipe(
          Effect.asVoid,
        )
      }),
      stopTurn: Effect.gen(function* () {
        const steers = yield* turns.stop

        if (steers === null) return null

        const cancelled = yield* interruptAll(session)

        return steers.filter(({ id }) => cancelled.includes(id)).map(sentOf)
      }),
      answer: Effect.fnUntraced(function* (requestId: string, answer: RequestAnswer) {
        const asked = waiting.get(requestId)

        if (asked === undefined) return yield* new RequestNotWaiting()

        const settled = yield* settleWith(asked.part, answer)
        waiting.delete(requestId)
        yield* Queue.offer(requests, Input.Settled({ requestId, answer }))
        yield* Deferred.succeed(asked.answered, permissionResult(settled, asked.input))

        return undefined
      }),
    }
  }),
})
