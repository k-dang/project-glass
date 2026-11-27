import { assert, it } from "@effect/vitest"
import type {
  CanUseTool,
  McpServerConfig,
  McpServerProvenance,
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { TurnStopped } from "@glass/contracts"
import { type Cause, Deferred, Effect, Fiber, Predicate, Queue, Redacted, Stream } from "effect"
import { eventually } from "../../test/eventually"
import { claudeAdapter, type ClaudeQuery } from "./claudeAdapter"
import { type GlassToolsAccess, type HostEvent, WorkRole } from "./protocol"
import { workInstructions } from "./workRole"

const idleQuery = (overrides: Partial<ClaudeQuery> = {}): ClaudeQuery => ({
  [Symbol.asyncIterator]: () => Stream.toAsyncIterable(Stream.never)[Symbol.asyncIterator](),
  initializationResult: async () => ({ models: [], commands: [] }),
  close: () => {},
  setModel: async () => {},
  setPermissionMode: async () => {},
  applyFlagSettings: async () => {},
  interrupt: async () => undefined,
  stopTask: async () => {},
  setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
  ...overrides,
})

const startWork = (
  query: (options: Options | undefined) => ClaudeQuery,
  {
    glassTools,
    report = () => Effect.void,
  }: { glassTools?: GlassToolsAccess; report?: (event: HostEvent) => Effect.Effect<void> } = {},
) =>
  claudeAdapter("claude-test", {
    query: ({ options }) => query(options),
    getSessionInfo: async () => undefined,
  }).start({
    folder: "checkout",
    thread: "new",
    role: WorkRole.make({}),
    glassTools,
    skills: [],
    report,
  })

const delivered = (text: string) => ({ message: text, images: [], context: null, prompt: text })

it.live("reports a failed SDK handshake as a host error and closes the query", () =>
  Effect.gen(function* () {
    let closed = false

    const failed = yield* startWork(() =>
      idleQuery({
        initializationResult: async () => {
          throw new Error("Handshake failed")
        },
        close: () => {
          closed = true
        },
      }),
    ).pipe(Effect.scoped, Effect.flip)

    assert.equal(failed._tag, "HostThreadError")
    assert.isTrue(closed)
  }),
)

it.live(
  "adds a Work Thread's MCP servers only after Claude Code starts, keeping the Glass tools bearer off its command line",
  () =>
    Effect.gen(function* () {
      const started: Array<Options> = []
      const added: Array<Record<string, McpServerConfig>> = []

      const query = (options: Options | undefined) => {
        if (options !== undefined) started.push(options)

        return idleQuery({
          setMcpServers: async (servers) => {
            added.push(servers)

            return { added: Object.keys(servers), removed: [], errors: {} }
          },
        })
      }

      yield* startWork(query).pipe(Effect.scoped)
      yield* startWork(query, {
        glassTools: { url: "http://127.0.0.1:9/mcp", bearer: Redacted.make("bearer") },
      }).pipe(Effect.scoped)

      assert.deepStrictEqual(
        started.map((options) => ({
          mcpServers: options.mcpServers,
          systemPrompt: options.systemPrompt,
        })),
        [
          { mcpServers: undefined, systemPrompt: { type: "preset", preset: "claude_code" } },
          {
            mcpServers: undefined,
            systemPrompt: { type: "preset", preset: "claude_code", append: workInstructions },
          },
        ],
      )

      assert.deepStrictEqual(
        added.map((servers) => Object.keys(servers)),
        [["glass"], ["glass", "glass_tools"]],
      )

      assert.deepStrictEqual(added[1]?.["glass_tools"], {
        type: "http",
        url: "http://127.0.0.1:9/mcp",
        headers: { authorization: "Bearer bearer" },
      })
    }),
)

it.live("approves without asking only the tools of Glass's own MCP servers", () =>
  Effect.gen(function* () {
    const given: Array<CanUseTool> = []
    const asked: Array<string> = []
    const approved: Array<string> = []

    const session = yield* startWork(
      (options) => {
        if (options?.canUseTool !== undefined) given.push(options.canUseTool)

        return idleQuery()
      },
      {
        report: (event) =>
          Effect.sync(() => {
            if (
              Predicate.isTagged(event, "PartSet") &&
              Predicate.isTagged(event.part, "PermissionRequest")
            )
              asked.push(event.part.requestId)
          }),
      },
    )

    yield* session.startTurn("turn-1", delivered("Use the tools"))

    const [canUseTool] = given
    assert.isDefined(canUseTool)

    const call = (toolUseID: string, served: { mcpServer?: McpServerProvenance }) => {
      void canUseTool(
        "mcp__glass__x__run",
        {},
        { signal: new AbortController().signal, toolUseID, requestId: toolUseID, ...served },
      ).then(
        (result) => {
          if (result?.behavior === "allow") approved.push(toolUseID)
        },
        () => {},
      )
    }

    call("glass", { mcpServer: { name: "glass", source: "sdk" } })
    call("glass-tools", { mcpServer: { name: "glass_tools", source: "dynamic" } })
    call("look-alike", { mcpServer: { name: "glass__x", source: "project" } })
    call("configured-glass-tools", { mcpServer: { name: "glass_tools", source: "project" } })
    call("unknown-server", {})

    yield* eventually(
      Effect.sync(() => {
        assert.deepStrictEqual(approved, ["glass", "glass-tools"])
        assert.deepStrictEqual(asked, ["look-alike", "configured-glass-tools", "unknown-server"])
      }),
    )
  }).pipe(Effect.scoped),
)

const stoppableTurn = Effect.fnUntraced(function* () {
  const messages = yield* Queue.unbounded<SDKMessage, Cause.Done>()
  const ended = yield* Deferred.make<void>()
  const events: Array<HostEvent> = []
  const cancelled: Array<string> = []
  let prompts: AsyncIterator<SDKUserMessage> | undefined
  let receipt = Promise.resolve()

  const interrupt = async () => {
    await receipt

    return { cancelled }
  }

  const query = idleQuery({
    [Symbol.asyncIterator]: () =>
      Stream.toAsyncIterable(Stream.fromQueue(messages))[Symbol.asyncIterator](),
    // SAFETY: Claude Code's interrupt answers with the queued messages it cancelled, which the SDK's types leave out.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- See SAFETY above.
    interrupt: interrupt as unknown as ClaudeQuery["interrupt"],
  })

  const session = yield* claudeAdapter("claude-test", {
    query: ({ prompt }) => {
      if (!Predicate.isString(prompt)) prompts = prompt[Symbol.asyncIterator]()

      return query
    },
    getSessionInfo: async () => undefined,
  }).start({
    folder: "checkout",
    thread: "new",
    role: WorkRole.make({}),
    glassTools: undefined,
    skills: [],
    report: (event) =>
      Effect.sync(() => events.push(event)).pipe(
        Effect.andThen(
          Predicate.isTagged(event, "TurnEnded") ? Deferred.succeed(ended, undefined) : Effect.void,
        ),
      ),
  })

  const sentUuid = Effect.promise(async () => (await prompts?.next())?.value?.uuid ?? "")

  yield* session.startTurn("turn-1", delivered("Build it"))
  yield* sentUuid

  return {
    session,
    cancelled,
    steer: (text: string) => session.steer(delivered(text)).pipe(Effect.andThen(sentUuid)),
    holdReceipt: () => {
      const held = Promise.withResolvers<void>()
      receipt = held.promise

      return Effect.sync(() => held.resolve())
    },
    exit: Queue.end(messages).pipe(Effect.andThen(Deferred.await(ended)), Effect.as(events)),
    end: Queue.offer(
      messages,
      // SAFETY: the result carries only the fields the Turn reads; Claude Code sends many more.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- See SAFETY above.
      { type: "result", subtype: "success", is_error: false, result: "done" } as SDKMessage,
    ).pipe(Effect.andThen(Deferred.await(ended)), Effect.as(events)),
  }
})

const shownSteers = (events: ReadonlyArray<HostEvent>) =>
  events.flatMap((event) =>
    Predicate.isTagged(event, "PartSet") && Predicate.isTagged(event.part, "Steer")
      ? [event.part.message]
      : [],
  )

it.live(
  "shows the Steers Claude Code took in before a stop and hands back those it cancelled",
  () =>
    Effect.gen(function* () {
      const turn = yield* stoppableTurn()

      yield* turn.steer("Use tabs")
      turn.cancelled.push(yield* turn.steer("Use spaces"))

      const returned = yield* turn.session.stopTurn("turn-1", TurnStopped.make({}))
      assert.deepStrictEqual(
        returned?.map(({ message }) => message),
        ["Use spaces"],
      )

      assert.deepStrictEqual(shownSteers(yield* turn.end), ["Use tabs"])
    }).pipe(Effect.scoped),
)

it.live("refuses a Steer once its Turn is stopping, so Glass queues it instead", () =>
  Effect.gen(function* () {
    const turn = yield* stoppableTurn()

    yield* turn.session.stopTurn("turn-1", TurnStopped.make({}))
    const refused = yield* turn.steer("Use tabs").pipe(Effect.flip)

    assert.equal(refused._tag, "HostThreadError")
    assert.deepStrictEqual(shownSteers(yield* turn.end), [])
  }).pipe(Effect.scoped),
)

it.live(
  "shows the Steers a stopping Turn holds when Claude Code exits before the stop's receipt",
  () =>
    Effect.gen(function* () {
      const turn = yield* stoppableTurn()

      turn.cancelled.push(yield* turn.steer("Use spaces"))
      const release = turn.holdReceipt()

      const stopping = yield* turn.session
        .stopTurn("turn-1", TurnStopped.make({}))
        .pipe(Effect.forkChild)

      const events = yield* turn.exit
      yield* release
      const returned = yield* Fiber.join(stopping)

      assert.deepStrictEqual(shownSteers(events), ["Use spaces"])
      assert.deepStrictEqual(returned, [])
    }).pipe(Effect.scoped),
)
