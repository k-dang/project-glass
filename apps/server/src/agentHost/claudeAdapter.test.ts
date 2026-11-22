import { assert, it } from "@effect/vitest"
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { TurnStopped } from "@glass/contracts"
import { type Cause, Deferred, Effect, Fiber, Predicate, Queue, Redacted, Stream } from "effect"
import { claudeAdapter, type ClaudeQuery } from "./claudeAdapter"
import { type GlassToolsAccess, type HostEvent, WorkRole } from "./protocol"
import { workInstructions } from "./workRole"

it.live("reports a failed SDK handshake as a host error and closes the query", () =>
  Effect.gen(function* () {
    let closed = false

    const query: ClaudeQuery = {
      [Symbol.asyncIterator]: () => Stream.toAsyncIterable(Stream.never)[Symbol.asyncIterator](),
      initializationResult: async () => {
        throw new Error("Handshake failed")
      },
      close: () => {
        closed = true
      },
      setModel: async () => {},
      setPermissionMode: async () => {},
      applyFlagSettings: async () => {},
      interrupt: async () => undefined,
    }

    const failed = yield* claudeAdapter("claude-test", {
      query: () => query,
      getSessionInfo: async () => undefined,
    })
      .start({
        folder: "checkout",
        thread: "new",
        role: WorkRole.make({}),
        glassTools: undefined,
        skills: [],
        report: () => Effect.void,
      })
      .pipe(Effect.scoped, Effect.flip)

    assert.equal(failed._tag, "HostThreadError")
    assert.isTrue(closed)
  }),
)

it.live("gives a Work Thread Glass's tools and how to use them only when it has tools", () =>
  Effect.gen(function* () {
    const given: Array<Options> = []

    const query: ClaudeQuery = {
      [Symbol.asyncIterator]: () => Stream.toAsyncIterable(Stream.never)[Symbol.asyncIterator](),
      initializationResult: async () => {
        throw new Error("Stop after reading the options")
      },
      close: () => {},
      setModel: async () => {},
      setPermissionMode: async () => {},
      applyFlagSettings: async () => {},
      interrupt: async () => undefined,
    }

    const adapter = claudeAdapter("claude-test", {
      query: ({ options }) => {
        if (options !== undefined) given.push(options)

        return query
      },
      getSessionInfo: async () => undefined,
    })

    const start = (glassTools: GlassToolsAccess | undefined) =>
      adapter
        .start({
          folder: "checkout",
          thread: "new",
          role: WorkRole.make({}),
          glassTools,
          skills: [],
          report: () => Effect.void,
        })
        .pipe(Effect.scoped, Effect.flip)

    yield* start(undefined)
    yield* start({ url: "http://127.0.0.1:9/mcp", bearer: Redacted.make("bearer") })

    assert.deepStrictEqual(
      given.map((options) => ({
        servers: Object.keys(options.mcpServers ?? {}),
        systemPrompt: options.systemPrompt,
      })),
      [
        { servers: ["glass"], systemPrompt: { type: "preset", preset: "claude_code" } },
        {
          servers: ["glass", "glass_tools"],
          systemPrompt: { type: "preset", preset: "claude_code", append: workInstructions },
        },
      ],
    )
  }),
)

const delivered = (text: string) => ({ message: text, images: [], context: null, prompt: text })

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

  const query: ClaudeQuery = {
    [Symbol.asyncIterator]: () =>
      Stream.toAsyncIterable(Stream.fromQueue(messages))[Symbol.asyncIterator](),
    initializationResult: async () => ({ models: [], commands: [] }),
    close: () => {},
    setModel: async () => {},
    setPermissionMode: async () => {},
    applyFlagSettings: async () => {},
    // SAFETY: Claude Code's interrupt answers with the queued messages it cancelled, which the SDK's types leave out.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- See SAFETY above.
    interrupt: interrupt as unknown as ClaudeQuery["interrupt"],
  }

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
