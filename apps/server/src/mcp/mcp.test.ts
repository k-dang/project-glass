import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Redacted, Schema, Scope } from "effect"
import { McpServer, Tool, Toolkit } from "effect/ai"
import { AgentRunners } from "../agentRunners"
import { LAUNCH_TOKEN, RENDERER_ORIGIN, startBackend } from "../../test/harness"
import { connectMcp, initialize, listedTools, mcpPost, toolResult } from "../../test/mcpClient"
import { McpCaller } from "./McpCredentials"

const DescribeTarget = Tool.make("describe_target", {
  description: "Names the caller and the conversation it asked about.",
  parameters: Schema.Struct({ conversationId: Schema.String }),
  success: Schema.Struct({ caller: Schema.String, target: Schema.String }),
})

const AwaitRelease = Tool.make("await_release", {
  description: "Waits until the test releases it.",
  success: Schema.String,
})

const TestTools = Toolkit.make(DescribeTarget, AwaitRelease)

const startMcpBackend = Effect.gen(function* () {
  const started = yield* Deferred.make<void>()
  const released = yield* Deferred.make<void>()
  const interrupted = yield* Deferred.make<void>()

  const tools = McpServer.toolkit(TestTools).pipe(
    Layer.provide(
      TestTools.toLayer({
        describe_target: ({ conversationId }) =>
          Effect.map(McpCaller.current, (caller) => ({
            caller: caller.conversationId,
            target: conversationId,
          })),
        await_release: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(released)),
            Effect.as("released"),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
      }),
    ),
  )

  const backend = yield* startBackend({}, undefined, AgentRunners.layer, tools)

  return { ...backend, started, released, interrupted }
})

const GLOBAL = { conversationId: "global-conversation" }

describe("MCP endpoint", () => {
  it.live("discovers and calls tools with the runtime's credential", () =>
    Effect.gen(function* () {
      const { baseUrl, mcpCredentials } = yield* startMcpBackend
      const bearer = yield* mcpCredentials.issue(GLOBAL)
      const mcp = yield* connectMcp(baseUrl, bearer)

      const listed = yield* mcp.request("tools/list", {}).response

      assert.deepStrictEqual(
        listedTools(listed).map((tool) => tool.name),
        ["describe_target", "await_release"],
      )
      assert.deepStrictEqual(listedTools(listed)[0]?.inputSchema.required, ["conversationId"])

      const called = yield* mcp.request("tools/call", {
        name: "describe_target",
        arguments: { conversationId: "another-conversation" },
      }).response

      assert.deepStrictEqual(toolResult(called).structuredContent, {
        caller: "global-conversation",
        target: "another-conversation",
      })
    }),
  )

  it.live("binds a session to the credential that opened it", () =>
    Effect.gen(function* () {
      const { baseUrl, mcpCredentials } = yield* startMcpBackend
      const mcp = yield* connectMcp(baseUrl, yield* mcpCredentials.issue(GLOBAL))
      const other = yield* mcpCredentials.issue({ conversationId: "other-runtime" })

      const intruding = yield* mcp.request("tools/list", {}, other).response

      assert.strictEqual(intruding.status, 404)

      const otherMcp = yield* connectMcp(baseUrl, other)

      const calledAsOther = yield* otherMcp.request("tools/call", {
        name: "describe_target",
        arguments: { conversationId: "another-conversation" },
      }).response

      assert.deepStrictEqual(toolResult(calledAsOther).structuredContent, {
        caller: "other-runtime",
        target: "another-conversation",
      })
    }),
  )

  it.live("rejects missing, incorrect and renderer credentials", () =>
    Effect.gen(function* () {
      const { baseUrl, mcpCredentials } = yield* startMcpBackend
      yield* mcpCredentials.issue(GLOBAL)

      const statuses = yield* Effect.all(
        [
          mcpPost(baseUrl, initialize),
          mcpPost(baseUrl, initialize, { bearer: Redacted.make("not-a-credential") }),
          mcpPost(baseUrl, initialize, { bearer: Redacted.make(LAUNCH_TOKEN) }),
          mcpPost(baseUrl, initialize, { query: `?token=${LAUNCH_TOKEN}` }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.map((responses) => responses.map((response) => response.status)))

      assert.deepStrictEqual(statuses, [401, 401, 401, 401])
    }),
  )

  it.live("refuses browser requests even with a valid credential", () =>
    Effect.gen(function* () {
      const { baseUrl, mcpCredentials } = yield* startMcpBackend
      const bearer = yield* mcpCredentials.issue(GLOBAL)

      const response = yield* mcpPost(baseUrl, initialize, {
        bearer,
        headers: { origin: RENDERER_ORIGIN },
      })

      assert.strictEqual(response.status, 403)
    }),
  )

  it.live("revokes a runtime's credential when it ends and issues a fresh one on restart", () =>
    Effect.gen(function* () {
      const { baseUrl, mcpCredentials } = yield* startMcpBackend
      const runtime = yield* Scope.make()
      const first = yield* mcpCredentials.issue(GLOBAL).pipe(Scope.provide(runtime))
      const mcp = yield* connectMcp(baseUrl, first)

      yield* Scope.close(runtime, Exit.void)

      const revoked = yield* mcp.request("tools/list", {}).response

      assert.strictEqual(revoked.status, 401)

      const second = yield* mcpCredentials.issue(GLOBAL)

      assert.notStrictEqual(Redacted.value(second), Redacted.value(first))

      const restarted = yield* connectMcp(baseUrl, second)

      assert.strictEqual((yield* restarted.request("tools/list", {}).response).status, 200)
    }),
  )

  it.live("ends a revoked credential's call that is still in flight", () =>
    Effect.gen(function* () {
      const { baseUrl, mcpCredentials, started, interrupted } = yield* startMcpBackend
      const runtime = yield* Scope.make()
      const bearer = yield* mcpCredentials.issue(GLOBAL).pipe(Scope.provide(runtime))
      const mcp = yield* connectMcp(baseUrl, bearer)

      const inFlight = yield* Effect.forkChild(
        mcp.request("tools/call", { name: "await_release", arguments: {} }).response,
      )

      yield* Deferred.await(started)
      yield* Scope.close(runtime, Exit.void)
      yield* Deferred.await(interrupted)

      assert.strictEqual((yield* Fiber.join(inFlight)).status, 401)
    }),
  )

  it.live("reports invalid tool input as a tool error the model can correct", () =>
    Effect.gen(function* () {
      const { baseUrl, mcpCredentials } = yield* startMcpBackend
      const mcp = yield* connectMcp(baseUrl, yield* mcpCredentials.issue(GLOBAL))

      const called = yield* mcp.request("tools/call", {
        name: "describe_target",
        arguments: { conversationId: 7 },
      }).response

      const result = toolResult(called)

      assert.strictEqual(result.isError, true)
      assert.include(JSON.stringify(result.content), "conversationId")
    }),
  )

  it.live("interrupts an in-flight call the client cancels", () =>
    Effect.gen(function* () {
      const { baseUrl, mcpCredentials, started, released, interrupted } = yield* startMcpBackend
      const mcp = yield* connectMcp(baseUrl, yield* mcpCredentials.issue(GLOBAL))
      const call = mcp.request("tools/call", { name: "await_release", arguments: {} })
      const inFlight = yield* Effect.forkChild(call.response)

      yield* Deferred.await(started)
      yield* mcp.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: call.id, reason: "Turn stopped" },
      })
      yield* Deferred.await(interrupted)
      yield* Deferred.succeed(released, undefined)

      const response = yield* Fiber.join(inFlight)

      assert.deepStrictEqual(response.messages, [])
    }),
  )
})
