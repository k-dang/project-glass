import { assert, describe, it } from "@effect/vitest"
import {
  AskUserAnswered,
  AskUserCancelled,
  AskUserResult,
  AskUserTimedOut,
  type NeedsYou,
  OutsideChoice,
  OutsideText,
} from "@glass/contracts"
import { Effect, Exit, Fiber, Option, Predicate, Redacted, Schema, Scope, Stream } from "effect"
import { startBackend } from "../../test/harness"
import { connectMcp, initialize, mcpPost, toolResult, toolText } from "../../test/mcpClient"

const outside = (items: NeedsYou) =>
  items.filter((item) => Predicate.isTagged(item, "OutsideQuestion"))

const askResult = Schema.decodeUnknownSync(AskUserResult)

const needsYou = (
  client: Effect.Success<ReturnType<typeof startBackend>>["client"],
  until: (items: NeedsYou) => boolean,
) =>
  client.WatchNeedsYou().pipe(Stream.filter(until), Stream.runHead, Effect.map(Option.getOrThrow))

const approve = (backend: Effect.Success<ReturnType<typeof startBackend>>) =>
  backend.outsideAgents.issue("Claude Code")

const start = Effect.gen(function* () {
  const backend = yield* startBackend({})
  const bearer = yield* approve(backend)
  const mcp = yield* connectMcp(backend.baseUrl, bearer)

  return { ...backend, bearer, mcp }
})

const askUntilProgress = (baseUrl: string, bearer: Redacted.Redacted) =>
  Effect.gen(function* () {
    const opened = yield* mcpPost(baseUrl, initialize, { bearer })

    assert.equal(opened.status, 200)
    assert.ok(opened.sessionId !== undefined)

    yield* mcpPost(
      baseUrl,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { bearer, sessionId: opened.sessionId },
    )

    return yield* Effect.promise(async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${Redacted.value(bearer)}`,
          "mcp-session-id": opened.sessionId ?? "",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "ask_user",
            arguments: { question: "Ship the retry change?" },
            _meta: { progressToken: "ask-1" },
          },
        }),
      })

      const reader = response.body?.getReader()

      if (reader === undefined) throw new Error("ask_user returned no body")

      const decoder = new TextDecoder()
      let text = ""

      while (!text.includes("notifications/progress")) {
        const chunk = await reader.read()

        if (chunk.value !== undefined) text += decoder.decode(chunk.value)

        if (chunk.done) break
      }

      return { status: response.status, text, reader }
    })
  })

describe("ask_user", () => {
  it.live("returns the free-text answer from the Inbox", () =>
    Effect.gen(function* () {
      const { client, mcp } = yield* start

      const call = mcp.request("tools/call", {
        name: "ask_user",
        arguments: { question: "Ship the retry change?" },
      })

      const inFlight = yield* Effect.forkChild(call.response)
      const shown = yield* needsYou(client, (items) => outside(items).length === 1)
      const question = outside(shown)[0]

      assert.ok(question !== undefined)
      assert.equal(question.question, "Ship the retry change?")
      assert.deepStrictEqual(question.choices, [])
      assert.equal(question.askedBy, "Claude Code")

      yield* client.AnswerOutsideQuestion({
        id: question.id,
        answer: OutsideText.make({ text: "Ship it" }),
      })

      const result = toolResult(yield* Fiber.join(inFlight))

      assert.deepStrictEqual(
        askResult(result.structuredContent),
        AskUserAnswered.make({ answer: "Ship it", by: "text" }),
      )
      assert.equal(outside(yield* needsYou(client, () => true)).length, 0)
    }),
  )

  it.live("returns the choice the user picks", () =>
    Effect.gen(function* () {
      const { client, mcp } = yield* start

      const call = mcp.request("tools/call", {
        name: "ask_user",
        arguments: {
          question: "Ship the retry change?",
          choices: ["Ship it", "Hold it"],
        },
      })

      const inFlight = yield* Effect.forkChild(call.response)
      const shown = yield* needsYou(client, (items) => outside(items).length === 1)
      const question = outside(shown)[0]

      assert.ok(question !== undefined)
      assert.deepStrictEqual(question.choices, ["Ship it", "Hold it"])

      yield* client.AnswerOutsideQuestion({
        id: question.id,
        answer: OutsideChoice.make({ choice: "Hold it" }),
      })

      assert.deepStrictEqual(
        askResult(toolResult(yield* Fiber.join(inFlight)).structuredContent),
        AskUserAnswered.make({ answer: "Hold it", by: "choice" }),
      )
    }),
  )

  it.live("returns timed out and drops the question when nobody answers", () =>
    Effect.gen(function* () {
      const { client, mcp } = yield* start

      const call = mcp.request("tools/call", {
        name: "ask_user",
        arguments: { question: "Still there?", timeoutSeconds: 1 },
      })

      const inFlight = yield* Effect.forkChild(call.response)

      yield* needsYou(client, (items) => outside(items).length === 1)

      assert.deepStrictEqual(
        askResult(toolResult(yield* Fiber.join(inFlight)).structuredContent),
        AskUserTimedOut.make({}),
      )
      assert.equal(
        outside(yield* needsYou(client, (items) => outside(items).length === 0)).length,
        0,
      )

      const late = yield* client
        .AnswerOutsideQuestion({ id: "gone", answer: OutsideText.make({ text: "too late" }) })
        .pipe(Effect.flip)

      assert.equal(late._tag, "OutsideQuestionNotWaiting")
    }),
  )

  it.live("rejects an unauthorized caller and posts nothing", () =>
    Effect.gen(function* () {
      const { baseUrl, client } = yield* startBackend({})

      const ask = {
        jsonrpc: "2.0" as const,
        id: 1,
        method: "tools/call",
        params: { name: "ask_user", arguments: { question: "Ship it?" } },
      }

      const statuses = yield* Effect.all(
        [
          mcpPost(baseUrl, ask),
          mcpPost(baseUrl, ask, { bearer: Redacted.make("not-a-credential") }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.map((responses) => responses.map((response) => response.status)))

      assert.deepStrictEqual(statuses, [401, 401])
      assert.equal(outside(yield* needsYou(client, () => true)).length, 0)
    }),
  )

  it.live("returns cancelled when Glass shuts down", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const backend = yield* startBackend({}).pipe(Scope.provide(scope))
      const bearer = yield* approve(backend)
      const mcp = yield* connectMcp(backend.baseUrl, bearer)

      const call = mcp.request("tools/call", {
        name: "ask_user",
        arguments: { question: "Ship the retry change?" },
      })

      const inFlight = yield* Effect.forkChild(call.response)

      yield* needsYou(backend.client, (items) => outside(items).length === 1)
      yield* Scope.close(scope, Exit.void)

      assert.deepStrictEqual(
        askResult(toolResult(yield* Fiber.join(inFlight)).structuredContent),
        AskUserCancelled.make({}),
      )
    }),
  )

  it.live("sends progress before the answer so the call outlives a client timeout", () =>
    Effect.gen(function* () {
      const backend = yield* startBackend({})
      const body = yield* askUntilProgress(backend.baseUrl, yield* approve(backend))

      assert.equal(body.status, 200)
      assert.include(body.text, "notifications/progress")
      assert.include(body.text, "ask-1")
      assert.equal(body.text.includes('"id":1'), false)

      const shown = yield* needsYou(backend.client, (items) => outside(items).length === 1)
      const question = outside(shown)[0]

      assert.ok(question !== undefined)
      yield* backend.client.AnswerOutsideQuestion({
        id: question.id,
        answer: OutsideText.make({ text: "Ship it" }),
      })
      yield* Effect.promise(() => body.reader.cancel())
    }),
  )

  it.live("ends a waiting question when its agent is disconnected", () =>
    Effect.gen(function* () {
      const backend = yield* startBackend({})
      const body = yield* askUntilProgress(backend.baseUrl, yield* approve(backend))

      yield* needsYou(backend.client, (items) => outside(items).length === 1)

      const [agent] = yield* backend.client
        .WatchOutsideAgents()
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

      assert.ok(agent !== undefined)
      yield* backend.client.RevokeOutsideAgent({ id: agent.id })

      yield* needsYou(backend.client, (items) => outside(items).length === 0)

      const rest = yield* Effect.promise(async () => {
        const decoder = new TextDecoder()
        let text = ""

        for (let chunk = await body.reader.read(); !chunk.done; chunk = await body.reader.read()) {
          text += decoder.decode(chunk.value)
        }

        return text
      })

      assert.equal(rest.includes("Answered"), false)
    }),
  )

  it.live("refuses a second question from the same MCP session, not from another", () =>
    Effect.gen(function* () {
      const { baseUrl, bearer, client, mcp } = yield* start
      const otherTerminal = yield* connectMcp(baseUrl, bearer)

      const first = yield* Effect.forkChild(
        mcp.request("tools/call", {
          name: "ask_user",
          arguments: { question: "Ship the retry change?" },
        }).response,
      )

      yield* needsYou(client, (items) => outside(items).length === 1)

      const second = toolResult(
        yield* mcp.request("tools/call", {
          name: "ask_user",
          arguments: { question: "And the follow-up?" },
        }).response,
      )

      assert.isTrue(second.isError)
      assert.include(toolText(second), "already waiting")

      const other = yield* Effect.forkChild(
        otherTerminal.request("tools/call", {
          name: "ask_user",
          arguments: { question: "Rebase first?" },
        }).response,
      )

      const shown = outside(yield* needsYou(client, (items) => outside(items).length === 2))

      yield* Effect.forEach(shown, (question) =>
        client.AnswerOutsideQuestion({
          id: question.id,
          answer: OutsideText.make({ text: "Yes" }),
        }),
      )
      yield* Fiber.join(first)
      yield* Fiber.join(other)
    }),
  )

  it.live("refuses a conversation Glass launched", () =>
    Effect.gen(function* () {
      const { baseUrl, client, mcpCredentials } = yield* startBackend({})
      const bearer = yield* mcpCredentials.issue({ conversationId: "conversation-1" })
      const mcp = yield* connectMcp(baseUrl, bearer)

      const result = yield* mcp.call("ask_user", { question: "Ship it?" })

      assert.isTrue(result.isError)
      assert.include(toolText(result), "its own Question tool")
      assert.equal(outside(yield* needsYou(client, () => true)).length, 0)
    }),
  )
})
