import {
  type CanUseTool,
  createSdkMcpServer,
  type EffortLevel as SdkEffortLevel,
  getSessionInfo,
  type Options,
  type ModelInfo,
  type PermissionResult,
  type Query,
  query,
  type SDKControlInitializeResponse,
  type SDKMessage,
  type SDKUserMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk"
import {
  type AgentCommand,
  type AgentModel,
  AgentModels,
  QuestionPart,
  type QuestionReply,
  type RequestAnswer,
  RequestNotWaiting,
  type RequestPart,
  DRAW_DIAGRAM_TOOL,
  SUGGEST_DRAFT_TOOL,
  withContextOf,
} from "@glass/contracts"
import {
  Deferred,
  Effect,
  Match,
  Option,
  Predicate,
  Queue,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { sdkExecutable } from "../processes"
import { claudeTools } from "../agentTools"
import type { AgentAdapter } from "./adapter"
import { Input, isFailure, machine } from "./claudeTurn"
import type { DeliveredMessage, DeliveredTurn } from "./deliveredMessage"
import {
  type AgentRole,
  couldNotSwitch,
  HostAgentError,
  notRunning,
  type ReviewBrief,
} from "./protocol"
import { settleWith } from "./requests"
import type { WrittenSkills } from "./sentSkills"
import { claudeToolInput, type ToolReply } from "./hostTool"
import { suggestDraft, suggestDraftDescription, suggestDraftParameters } from "./suggestDraftTool"
import { drawDiagram, drawDiagramDescription, drawDiagramParameters } from "./drawDiagramTool"
import { GLASS_MCP_PREFIX, GLASS_MCP_SERVER, permissionRequest, ToolInput } from "./toolCalls"
import { runTurns } from "./turnLoop"

const QUESTION_TOOL = "AskUserQuestion"

const START_TIMEOUT = "60 seconds"

const effortLevels = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies ReadonlyArray<SdkEffortLevel>

const EffortLevel = Schema.NullOr(Schema.Literals(effortLevels))

export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  readonly initializationResult: () => Promise<
    Pick<SDKControlInitializeResponse, "models" | "commands">
  >
  readonly close: Query["close"]
  readonly setModel: Query["setModel"]
  readonly setPermissionMode: Query["setPermissionMode"]
  readonly applyFlagSettings: Query["applyFlagSettings"]
  readonly interrupt: Query["interrupt"]
}

export interface ClaudeSdk {
  readonly query: (input: Parameters<typeof query>[0]) => ClaudeQuery
  readonly getSessionInfo: typeof getSessionInfo
}

const liveSdk: ClaudeSdk = { query, getSessionInfo }

const startFailure = (cause: unknown) =>
  new HostAgentError({
    message: /ENOENT|not found/i.test(String(cause))
      ? "Claude Code isn't installed. Install it, or set claudeCommand in Glass's settings.json to its path and restart Glass."
      : "Claude Code could not start. Check its installation.",
  })

const suggestDraftInput = claudeToolInput(suggestDraftParameters)

const drawDiagramInput = claudeToolInput(drawDiagramParameters)

const toolResult = ({ accepted, text }: ToolReply) =>
  Promise.resolve({ content: [{ type: "text" as const, text }], isError: !accepted })

const reviewOptions = (brief: ReviewBrief): Options => ({
  systemPrompt: { type: "preset", preset: "claude_code", append: brief.instructions },
  tools: [...claudeTools.shell],
  allowedTools: [...claudeTools.shell, `${GLASS_MCP_PREFIX}${SUGGEST_DRAFT_TOOL}`],
  settingSources: [],
  strictMcpConfig: true,
  mcpServers: {
    [GLASS_MCP_SERVER]: createSdkMcpServer({
      name: GLASS_MCP_SERVER,
      tools: [
        tool(SUGGEST_DRAFT_TOOL, suggestDraftDescription, suggestDraftInput, (input) =>
          toolResult(suggestDraft(brief)(input)),
        ),
      ],
    }),
  },
})

const workOptions = (): Options => ({
  allowedTools: [`${GLASS_MCP_PREFIX}${DRAW_DIAGRAM_TOOL}`],
  mcpServers: {
    [GLASS_MCP_SERVER]: createSdkMcpServer({
      name: GLASS_MCP_SERVER,
      tools: [
        tool(DRAW_DIAGRAM_TOOL, drawDiagramDescription, drawDiagramInput, (input) =>
          toolResult(drawDiagram(input)),
        ),
      ],
    }),
  },
})

const roleOptions = (role: AgentRole): Options =>
  Match.value(role).pipe(
    Match.tagsExhaustive({
      Work: workOptions,
      Review: ({ brief }) => reviewOptions(brief),
    }),
  )

const pluginOptions = (skills: ReadonlyArray<WrittenSkills>): Options =>
  skills.length === 0
    ? {}
    : {
        plugins: skills.map(({ plugin }) => ({
          type: "local",
          path: plugin,
          skipMcpDiscovery: true,
        })),
      }

const startClaude = (
  sdk: ClaudeSdk,
  command: string,
  folder: string,
  prompt: AsyncIterable<SDKUserMessage>,
  canUseTool: CanUseTool,
  extra: Options = {},
): Effect.Effect<
  {
    readonly session: ClaudeQuery
    readonly initialized: Pick<SDKControlInitializeResponse, "models" | "commands">
  },
  HostAgentError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const session = yield* Effect.acquireRelease(
      Effect.sync(() =>
        sdk.query({
          prompt,
          options: {
            pathToClaudeCodeExecutable: sdkExecutable(command),
            cwd: folder,
            // The SDK's own default system prompt is empty, unlike the terminal `claude`'s.
            systemPrompt: { type: "preset", preset: "claude_code" },
            includePartialMessages: true,
            ...extra,
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

const userMessage = ({ prompt, images }: DeliveredTurn): SDKUserMessage => ({
  type: "user",
  message: {
    role: "user",
    content:
      images.length === 0
        ? prompt
        : [
            ...images.map(({ mediaType, data }) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: mediaType, data },
            })),
            { type: "text" as const, text: prompt },
          ],
  },
  parent_tool_use_id: null,
})

interface CancellingInterrupt {
  interrupt(options: { readonly cancelQueued: boolean }): ReturnType<Query["interrupt"]>
}

const interruptAll = (session: ClaudeQuery) =>
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

const requestOf = (requestId: string, toolName: string, input: ToolInput) => {
  if (toolName === QUESTION_TOOL) {
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

/**
 * Starts Claude Code in `folder` only for its handshake, which sends the model nothing. It still
 * starts what the folder's settings start, such as MCP servers, plugins, and SessionStart hooks.
 */
const handshake = (sdk: ClaudeSdk, command: string, folder: string, extra: Options = {}) =>
  startClaude(
    sdk,
    command,
    folder,
    Stream.toAsyncIterable(Stream.never),
    () => Promise.resolve({ behavior: "deny", message: "Glass is only asking what it offers." }),
    extra,
  ).pipe(Effect.map(({ initialized }) => initialized))

export const claudeAdapter = (
  command: string,
  sdk: ClaudeSdk = liveSdk,
): AgentAdapter<AgentRole> => ({
  models: Effect.gen(function* () {
    const initialized = yield* handshake(sdk, command, homedir())

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

  commands: (folder, skills) =>
    handshake(sdk, command, folder, pluginOptions(skills)).pipe(
      Effect.map(({ commands }) =>
        commands.map(({ name, description }): AgentCommand => ({ name, description })),
      ),
      Effect.scoped,
    ),

  start: Effect.fnUntraced(function* ({ folder, conversation, role, skills, report }) {
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
        Effect.onInterrupt(() => Queue.offer(requests, Input.Expired({ requestId }))),
        Effect.ensuring(Effect.sync(() => waiting.delete(requestId))),
      )

    // Claude Code refuses to resume a conversation it hasn't saved, and to start one it has.
    const saved = yield* Effect.tryPromise(() =>
      sdk.getSessionInfo(conversation, { dir: folder }),
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
      sdk,
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
      {
        ...(saved === undefined ? { sessionId: conversation } : { resume: conversation }),
        ...roleOptions(role),
        ...pluginOptions(skills),
      },
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
      startTurn: Effect.fnUntraced(function* (turnId: string, sent: DeliveredTurn) {
        yield* turns.begin(turnId, withContextOf(sent))

        return yield* Queue.offer(prompts, { ...userMessage(sent), uuid: randomUUID() }).pipe(
          Effect.asVoid,
        )
      }),
      // Claude Code folds a message with priority `next` into the running Turn between tool rounds.
      steer: Effect.fnUntraced(function* (sent: DeliveredMessage) {
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

        return steers.filter(({ id }) => cancelled.includes(id)).map(withContextOf)
      }),
      answer: Effect.fnUntraced(function* (requestId: string, answer: RequestAnswer) {
        const asked = waiting.get(requestId)

        if (asked === undefined) return yield* new RequestNotWaiting()

        const settled = yield* settleWith(asked.part, answer)
        waiting.delete(requestId)
        yield* Queue.offer(requests, Input.Answered({ requestId, answer }))
        yield* Deferred.succeed(asked.answered, permissionResult(settled, asked.input))

        return undefined
      }),
    }
  }),
})
