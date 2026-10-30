import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk"
import { assert, it } from "@effect/vitest"
import {
  AllowRequest,
  AnswerQuestion,
  DenyRequest,
  isRequestPart,
  type AgentEvent,
} from "@glass/contracts"
import { Effect, Option, Predicate, Queue, Result, Stream } from "effect"
import { claudeAdapter, type ClaudeQuery, type ClaudeSdk } from "./claudeAdapter"

const fixture = Effect.gen(function* () {
  const events = yield* Queue.unbounded<AgentEvent>()
  const inputs: Array<Parameters<ClaudeSdk["query"]>[0]> = []
  const models: Array<Parameters<ClaudeQuery["setModel"]>[0]> = []
  const modes: Array<Parameters<ClaudeQuery["setPermissionMode"]>[0]> = []
  const flags: Array<Parameters<ClaudeQuery["applyFlagSettings"]>[0]> = []
  let closed = false
  let interrupted = false

  const query: ClaudeQuery = {
    [Symbol.asyncIterator]: () => Stream.toAsyncIterable(Stream.never)[Symbol.asyncIterator](),
    initializationResult: async () => ({ models: [] }),
    close: () => {
      closed = true
    },
    setModel: async (model) => {
      models.push(model)
    },
    setPermissionMode: async (mode) => {
      modes.push(mode)
    },
    applyFlagSettings: async (settings) => {
      flags.push(settings)
    },
    interrupt: async () => {
      interrupted = true

      return undefined
    },
  }

  const sdk: ClaudeSdk = {
    query: (input) => {
      inputs.push(input)

      return query
    },
    getSessionInfo: async () => undefined,
  }

  return {
    sdk,
    query,
    models,
    modes,
    flags,
    closed: () => closed,
    interrupted: () => interrupted,
    input: () => Option.getOrThrow(Option.fromNullishOr(inputs[0])),
    ask: (tool: string, input: Parameters<CanUseTool>[1], signal = new AbortController().signal) =>
      Option.getOrThrow(Option.fromNullishOr(inputs[0]?.options?.canUseTool))(tool, input, {
        toolUseID: "tool-1",
        requestId: "control-1",
        signal,
      }),
    report: (event: AgentEvent) => Queue.offer(events, event).pipe(Effect.asVoid),
    part: (status: string) =>
      Stream.fromQueue(events).pipe(
        Stream.filterMap((event) =>
          Predicate.isTagged(event, "PartSet") &&
          isRequestPart(event.part) &&
          event.part.status === status
            ? Result.succeed(event.part)
            : Result.fail(undefined),
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      ),
  }
})

it.live(
  "configures the SDK session, resumes saved conversations, and closes it with its scope",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* Effect.gen(function* () {
        const session = yield* claudeAdapter("claude-test", {
          ...f.sdk,
          getSessionInfo: async () => ({ sessionId: "saved", summary: "Saved", lastModified: 0 }),
        }).start({ folder: "checkout", conversation: "saved", report: f.report })

        assert.equal(f.input().options?.resume, "saved")
        assert.equal(f.input().options?.cwd, "checkout")
        assert.equal(f.input().options?.pathToClaudeCodeExecutable, "claude-test")
        yield* session.configure({ model: "sonnet", effort: "high", permissionMode: "acceptEdits" })
        assert.deepStrictEqual(f.models, ["sonnet"])
        assert.deepStrictEqual(f.modes, ["acceptEdits"])
        assert.deepStrictEqual(f.flags, [{ effortLevel: "high" }])
        yield* session.startTurn("turn-1", { message: "Hello", images: [] })
        yield* session.stopTurn
        assert.isTrue(f.interrupted())
      }).pipe(Effect.scoped)
      assert.isTrue(f.closed())
    }),
)

it.live("translates an SDK permission callback and the user's denial in both directions", () =>
  Effect.gen(function* () {
    const f = yield* fixture

    const session = yield* claudeAdapter("claude-test", f.sdk).start({
      folder: "checkout",
      conversation: "new",
      report: f.report,
    })

    assert.equal(f.input().options?.sessionId, "new")
    yield* session.startTurn("turn-1", { message: "Hello", images: [] })
    const result = f.ask("Bash", { command: "touch notes.txt" })
    const part = yield* f.part("waiting")
    assert.ok(Predicate.isTagged(part, "PermissionRequest"))
    assert.equal(part.toolName, "Bash")
    assert.equal(part.input, JSON.stringify({ command: "touch notes.txt" }, null, 2))
    yield* session.answer(part.requestId, DenyRequest.make({ reason: "Leave it alone" }))
    assert.deepStrictEqual(yield* Effect.promise(() => result), {
      behavior: "deny",
      message: "Leave it alone",
    })
    assert.equal((yield* f.part("denied")).requestId, part.requestId)
    assert.equal(
      (yield* session.answer(part.requestId, AllowRequest.make({})).pipe(Effect.flip))._tag,
      "RequestNotWaiting",
    )
  }),
)

it.live("translates Questions and validates answers before returning the SDK's updated input", () =>
  Effect.gen(function* () {
    const f = yield* fixture

    const session = yield* claudeAdapter("claude-test", f.sdk).start({
      folder: "checkout",
      conversation: "new",
      report: f.report,
    })

    yield* session.startTurn("turn-1", { message: "Hello", images: [] })

    const input = {
      questions: [
        { question: "Which files?", header: "Scope", options: [{ label: "README" }] },
        { question: "Why?", options: [] },
      ],
    }

    const result = f.ask("AskUserQuestion", input)
    const part = yield* f.part("waiting")
    assert.ok(Predicate.isTagged(part, "Question"))
    assert.isTrue(part.questions.every(({ freeText }) => freeText))
    assert.equal(
      (yield* session.answer(part.requestId, AllowRequest.make({})).pipe(Effect.flip))._tag,
      "HostAgentError",
    )

    const answer = AnswerQuestion.make({
      answers: [
        { chosen: ["README"], text: null },
        { chosen: [], text: "Start small" },
      ],
    })

    yield* session.answer(part.requestId, answer)
    assert.deepStrictEqual(yield* Effect.promise(() => result), {
      behavior: "allow",
      updatedInput: { ...input, answers: { "Which files?": "README", "Why?": "Start small" } },
    })
    const settled = yield* f.part("answered")
    assert.ok(Predicate.isTagged(settled, "Question"))
    assert.deepStrictEqual(settled.answers, answer.answers)
  }),
)

it.live("expires an SDK callback when its abort signal fires", () =>
  Effect.gen(function* () {
    const f = yield* fixture

    const session = yield* claudeAdapter("claude-test", f.sdk).start({
      folder: "checkout",
      conversation: "new",
      report: f.report,
    })

    yield* session.startTurn("turn-1", { message: "Hello", images: [] })
    const controller = new AbortController()

    const result = f.ask("Bash", { command: "touch notes.txt" }, controller.signal).then(
      () => "answered",
      () => "aborted",
    )

    const waiting = yield* f.part("waiting")
    controller.abort()
    assert.equal(yield* Effect.promise(() => result), "aborted")
    assert.equal((yield* f.part("expired")).requestId, waiting.requestId)
    assert.equal(
      (yield* session.answer(waiting.requestId, AllowRequest.make({})).pipe(Effect.flip))._tag,
      "RequestNotWaiting",
    )
  }),
)

it.live("reports a failed SDK handshake as a host error and closes the query", () =>
  Effect.gen(function* () {
    const f = yield* fixture

    const failed = yield* claudeAdapter("claude-test", {
      ...f.sdk,
      query: () => ({
        ...f.query,
        initializationResult: async () => {
          throw new Error("Handshake failed")
        },
      }),
    })
      .start({ folder: "checkout", conversation: "new", report: f.report })
      .pipe(Effect.scoped, Effect.flip)

    assert.equal(failed._tag, "HostAgentError")
    assert.isTrue(f.closed())
  }),
)
