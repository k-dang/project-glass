import {
  type CanUseTool,
  createSdkMcpServer,
  type EffortLevel as SdkEffortLevel,
  getSessionInfo,
  type McpServerConfig,
  type McpServerProvenance,
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
  AgentStatusesChanged,
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
  DateTime,
  Deferred,
  Effect,
  FiberSet,
  Match,
  Option,
  Predicate,
  Queue,
  Redacted,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { sdkExecutable } from "../processes"
import { claudeTools } from "../agentTools"
import type { HarnessAdapter } from "./adapter"
import {
  backgroundActivity,
  noBackgroundTasks,
  trackBackgroundTasks,
} from "./claudeBackgroundTasks"
import { Input, isFailure, machine } from "./claudeTurn"
import { agentImages, type DeliveredMessage, type DeliveredTurn } from "./deliveredMessage"
import {
  type RepositoryRole,
  couldNotSwitch,
  type GlassToolsAccess,
  HostThreadError,
  notRunning,
  type ReviewBrief,
} from "./protocol"
import { settleWith } from "./requests"
import type { WrittenSkills } from "./sentSkills"
import { claudeToolInput, type ToolReply } from "./hostTool"
import { suggestDraft, suggestDraftDescription, suggestDraftParameters } from "./suggestDraftTool"
import { drawDiagram, drawDiagramDescription, drawDiagramParameters } from "./drawDiagramTool"
import { GLASS_MCP_SERVER, GLASS_TOOLS_MCP_SERVER, permissionRequest, ToolInput } from "./toolCalls"
import { runTurns } from "./turnLoop"
import { workInstructions } from "./workRole"

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
  readonly stopTask: Query["stopTask"]
  readonly setMcpServers: Query["setMcpServers"]
}

export interface ClaudeSdk {
  readonly query: (input: Parameters<typeof query>[0]) => ClaudeQuery
  readonly getSessionInfo: typeof getSessionInfo
}

const liveSdk: ClaudeSdk = { query, getSessionInfo }

const startFailure = (cause: unknown) =>
  new HostThreadError({
    message: /ENOENT|not found/i.test(String(cause))
      ? "Claude Code isn't installed. Install it, or set claudeCommand in Glass's settings.json to its path and restart Glass."
      : "Claude Code could not start. Check its installation.",
  })

const suggestDraftInput = claudeToolInput(suggestDraftParameters)

const drawDiagramInput = claudeToolInput(drawDiagramParameters)

const toolResult = ({ accepted, text }: ToolReply) =>
  Promise.resolve({ content: [{ type: "text" as const, text }], isError: !accepted })

const reviewTools = claudeTools.shell

const reviewOptions = (brief: ReviewBrief): Options => ({
  systemPrompt: { type: "preset", preset: "claude_code", append: brief.instructions },
  tools: [...reviewTools],
  settingSources: [],
  strictMcpConfig: true,
  mcpServers: {
    [GLASS_MCP_SERVER]: createSdkMcpServer({
      name: GLASS_MCP_SERVER,
      tools: [
        tool(SUGGEST_DRAFT_TOOL, suggestDraftDescription, suggestDraftInput, (input) =>
          toolResult(suggestDraft(brief.diffLines)(input)),
        ),
      ],
    }),
  },
})

interface RoleSetup {
  readonly options: Options
  // WARNING: The SDK puts startup mcpServers on Claude Code's command line, and setMcpServers drops each in-process server it isn't given, so Work adds all of its servers after start.
  readonly addedServers?: Record<string, McpServerConfig>
}

const workSetup = (tools: GlassToolsAccess | undefined): RoleSetup => {
  const glass = createSdkMcpServer({
    name: GLASS_MCP_SERVER,
    tools: [
      tool(DRAW_DIAGRAM_TOOL, drawDiagramDescription, drawDiagramInput, (input) =>
        toolResult(drawDiagram(input)),
      ),
    ],
  })

  if (tools === undefined) return { options: {}, addedServers: { [GLASS_MCP_SERVER]: glass } }

  return {
    options: {
      systemPrompt: { type: "preset", preset: "claude_code", append: workInstructions },
    },
    addedServers: {
      [GLASS_MCP_SERVER]: glass,
      [GLASS_TOOLS_MCP_SERVER]: {
        type: "http",
        url: tools.url,
        headers: { authorization: `Bearer ${Redacted.value(tools.bearer)}` },
      },
    },
  }
}

const roleSetup = (role: RepositoryRole, glassTools: GlassToolsAccess | undefined): RoleSetup =>
  Match.value(role).pipe(
    Match.tagsExhaustive({
      Work: () => workSetup(glassTools),
      Review: ({ brief }) => ({ options: reviewOptions(brief) }),
    }),
  )

// WARNING: A folder's own config may name an MCP server anything, even one whose tool names start like Glass's, so trust only where Claude Code says a server came from.
const isGlassServer = (server: McpServerProvenance | undefined) =>
  (server?.source === "sdk" && server.name === GLASS_MCP_SERVER) ||
  (server?.source === "dynamic" && server.name === GLASS_TOOLS_MCP_SERVER)

// WARNING: Approve these here, not in allowedTools: Claude Code skips canUseTool for allowedTools.
const approvedIn = (role: RepositoryRole) => {
  const builtIn: ReadonlyArray<string> = Match.value(role).pipe(
    Match.tagsExhaustive({ Work: () => [], Review: () => reviewTools }),
  )

  return (toolName: string, server: McpServerProvenance | undefined) =>
    isGlassServer(server) || builtIn.includes(toolName)
}

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
  { options, addedServers }: RoleSetup,
): Effect.Effect<
  {
    readonly session: ClaudeQuery
    readonly initialized: Pick<SDKControlInitializeResponse, "models" | "commands">
  },
  HostThreadError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const runFork = yield* FiberSet.makeRuntime()

    const session = yield* Effect.acquireRelease(
      Effect.sync(() =>
        sdk.query({
          prompt,
          options: {
            pathToClaudeCodeExecutable: sdkExecutable(command),
            cwd: folder,
            // WARNING: The Agent SDK's default system prompt is empty, unlike the terminal claude's.
            systemPrompt: { type: "preset", preset: "claude_code" },
            includePartialMessages: true,
            ...options,
            canUseTool,
            // WARNING: Required so the user can switch to bypassPermissions between Turns.
            allowDangerouslySkipPermissions: true,
            stderr: (data) => {
              if (data.trim() !== "") runFork(Effect.logWarning("claude wrote to stderr", data))
            },
          },
        }),
      ),
      (opened) => Effect.sync(() => opened.close()),
    )

    const { initialized, unconnected } = yield* Effect.tryPromise(async () => ({
      initialized: await session.initializationResult(),
      unconnected:
        addedServers === undefined ? {} : (await session.setMcpServers(addedServers)).errors,
    })).pipe(
      Effect.timeoutOrElse({
        duration: START_TIMEOUT,
        orElse: () => Effect.fail("claude didn't finish starting"),
      }),
      Effect.tapError((cause) => Effect.logWarning("Claude Code could not start", cause)),
      Effect.mapError(startFailure),
    )

    if (Object.keys(unconnected).length > 0)
      yield* Effect.logWarning("Claude Code couldn't connect to MCP servers", unconnected)

    return { session, initialized }
  })

const toModel = (info: ModelInfo): AgentModel => ({
  id: info.value,
  name: info.displayName,
  efforts: info.supportedEffortLevels ?? [],
})

const userMessage = (delivered: DeliveredTurn): SDKUserMessage => {
  const { prompt } = delivered
  const images = agentImages(delivered)

  return {
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
  }
}

interface CancellingInterrupt {
  interrupt(options: { readonly cancelQueued: boolean }): ReturnType<Query["interrupt"]>
}

const interruptAll = (session: ClaudeQuery) =>
  Effect.tryPromise(async () => {
    // SAFETY: SDK 0.3.322's interrupt reads { cancelQueued } and sends it as cancel_queued, but its types declare interrupt() without options.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- See SAFETY above.
    const cancelling = session as unknown as CancellingInterrupt
    const receipt = await cancelling.interrupt({ cancelQueued: true })

    return receipt?.cancelled ?? []
  }).pipe(
    Effect.tapError((cause) => Effect.logWarning("Claude Code refused to stop", cause)),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  )

const sameActivity = Schema.toEquivalence(AgentStatusesChanged)

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
          freeText: true,
        })),
        status: "waiting",
        answers: null,
      })
  }

  return permissionRequest(requestId, toolName, input)
}

const replyText = (reply: QuestionReply | undefined) =>
  reply?.text ?? reply?.chosen.join(", ") ?? ""

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

// WARNING: The handshake sends the model nothing but still starts the folder's MCP servers, plugins, and SessionStart hooks.
const handshake = (sdk: ClaudeSdk, command: string, folder: string, options: Options = {}) =>
  startClaude(
    sdk,
    command,
    folder,
    Stream.toAsyncIterable(Stream.never),
    () => Promise.resolve({ behavior: "deny", message: "Glass is only asking what it offers." }),
    { options },
  ).pipe(Effect.map(({ initialized }) => initialized))

export const claudeAdapter = (
  command: string,
  sdk: ClaudeSdk = liveSdk,
): HarnessAdapter<RepositoryRole> => ({
  models: Effect.gen(function* () {
    const initialized = yield* handshake(sdk, command, homedir())

    const { models } = initialized
    const defaultModelEntry = models.find((model) => model.value === "default")
    const others = models.filter((model) => model !== defaultModelEntry)

    const resolved = others.find(
      (model) =>
        defaultModelEntry?.resolvedModel !== undefined &&
        model.resolvedModel === defaultModelEntry.resolvedModel,
    )

    return new AgentModels({
      defaultModel:
        defaultModelEntry === undefined
          ? null
          : {
              ...toModel(defaultModelEntry),
              name: resolved?.displayName ?? defaultModelEntry.displayName,
            },
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

  start: Effect.fnUntraced(function* ({ folder, thread, role, glassTools, skills, report }) {
    const prompts = yield* Queue.unbounded<SDKUserMessage>()
    const requests = yield* Queue.unbounded<Input>()
    const waiting = new Map<string, Asked>()
    const runPromise = yield* FiberSet.makeRuntimePromise()

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

    // WARNING: Claude Code refuses to resume a session it hasn't saved, and to start one it has.
    const saved = yield* Effect.tryPromise(() => sdk.getSessionInfo(thread, { dir: folder })).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Couldn't look up a Claude Code session", cause),
      ),
      Effect.mapError(
        () =>
          new HostThreadError({
            message: "Glass couldn't look up this Thread's Claude Code session. Try again.",
          }),
      ),
    )

    const approved = approvedIn(role)

    const canUseTool: CanUseTool = (toolName, input, { toolUseID, signal, mcpServer }) =>
      approved(toolName, mcpServer)
        ? Promise.resolve({ behavior: "allow", updatedInput: input })
        : runPromise(
            ask(
              toolName,
              Option.getOrElse(decodeToolInput(input), () => ({})),
              toolUseID,
            ),
            { signal },
          )

    const setup = roleSetup(role, glassTools)

    const { session } = yield* startClaude(
      sdk,
      command,
      folder,
      Stream.toAsyncIterable(Stream.fromQueue(prompts)),
      canUseTool,
      {
        ...setup,
        options: {
          ...(saved === undefined ? { sessionId: thread } : { resume: thread }),
          ...setup.options,
          ...pluginOptions(skills),
        },
      },
    )

    let background = noBackgroundTasks
    let shown = backgroundActivity(background)

    const show = (activity: AgentStatusesChanged) =>
      Effect.suspend(() => {
        if (sameActivity(activity, shown)) return Effect.void

        shown = activity

        return report(activity)
      })

    const follow = (message: SDKMessage) =>
      Effect.flatMap(DateTime.now, (now) => {
        const tracked = trackBackgroundTasks(background, message, now)
        background = tracked.tasks

        const inputs = [
          Input.Message({ message }),
          ...(tracked.ended === null ? [] : [Input.BackgroundWorkEnded(tracked.ended)]),
        ]

        return show(backgroundActivity(background)).pipe(Effect.as(inputs))
      })

    const turns = yield* runTurns({
      harness: "Claude Code",
      machine,
      events: Stream.fromAsyncIterable(session, (cause) => cause).pipe(
        Stream.tap((message) =>
          isFailure(message)
            ? Effect.logWarning("Claude Code ended a Turn with an error", message)
            : Effect.void,
        ),
        Stream.mapEffect(follow),
        Stream.flattenIterable,
        Stream.ensuring(show(backgroundActivity(noBackgroundTasks))),
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
      steer: Effect.fnUntraced(function* (sent: DeliveredMessage) {
        const uuid = randomUUID()

        if (!(yield* turns.steer({ ...sent, id: uuid }))) return yield* notRunning

        // WARNING: Claude Code folds a priority next message into the running Turn between tool rounds.
        return yield* Queue.offer(prompts, { ...userMessage(sent), uuid, priority: "next" }).pipe(
          Effect.asVoid,
        )
      }),
      stopTurn: (turnId, ending) =>
        Effect.gen(function* () {
          const steers = yield* turns.stop(turnId, ending)

          if (steers === null) return null

          const cancelled = yield* interruptAll(session)

          const returned = yield* Effect.filter(steers, ({ id }) =>
            cancelled.includes(id) ? turns.dropSteer(id) : Effect.succeed(false),
          )

          return returned.map(withContextOf)
        }),
      stopBackgroundTask: (taskId) =>
        Effect.tryPromise(() => session.stopTask(taskId)).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Claude Code refused to stop a background task", cause),
          ),
          Effect.mapError(
            () =>
              new HostThreadError({ message: "Claude Code couldn't stop that task. Try again." }),
          ),
        ),
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
