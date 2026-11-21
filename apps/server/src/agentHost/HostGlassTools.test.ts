import { assert, it } from "@effect/vitest"
import { Context, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import { McpSchema, McpServer } from "effect/ai"
import { HostGlassTools, lostConnection, notConnected } from "./HostGlassTools"
import { Journal } from "./Journal"

const answered = new McpSchema.CallToolResult({ content: [{ type: "text", text: "answered" }] })

const tool = (name: string) =>
  new McpSchema.Tool({ name, inputSchema: { type: "object", properties: {} } })

const relay = Effect.gen(function* () {
  const context = yield* Layer.build(
    HostGlassTools.layer.pipe(
      Layer.provideMerge(Journal.layer),
      Layer.provideMerge(McpServer.McpServer.layer),
    ),
  )

  const tools = Context.get(context, HostGlassTools)
  const { host } = Context.get(context, Journal)

  const watching = Effect.gen(function* () {
    const scope = yield* Scope.make()
    const pull = yield* Stream.toPull(tools.watch(host)).pipe(Scope.provide(scope))

    return {
      next: pull.pipe(Effect.map(([call]) => call)),
      end: Scope.close(scope, Exit.void),
    }
  })

  const calling = tools.call("thread", "list_queue", {}).pipe(Effect.forkChild)

  return { tools, host, server: Context.get(context, McpServer.McpServer), watching, calling }
})

it.effect("answers a call no backend watches for as not connected", () =>
  Effect.gen(function* () {
    const { tools } = yield* relay

    assert.deepStrictEqual(yield* tools.call("thread", "list_queue", {}), notConnected)
  }),
)

it.effect("fails a call as lost once the watcher it was handed to ends", () =>
  Effect.gen(function* () {
    const f = yield* relay
    const watcher = yield* f.watching
    const call = yield* f.calling
    yield* watcher.next

    yield* watcher.end

    assert.deepStrictEqual(yield* Fiber.join(call), lostConnection)
  }),
)

it.effect("keeps a call pending with a newer watcher when the older watcher ends late", () =>
  Effect.gen(function* () {
    const f = yield* relay
    const older = yield* f.watching
    const newer = yield* f.watching
    const call = yield* f.calling
    const { callId } = yield* newer.next

    yield* older.end
    yield* f.tools.answer(f.host, callId, answered)

    assert.deepStrictEqual(yield* Fiber.join(call), answered)
  }),
)

it.effect("ignores an answer for an unknown call or for another host", () =>
  Effect.gen(function* () {
    const f = yield* relay
    const watcher = yield* f.watching
    const call = yield* f.calling
    const { callId } = yield* watcher.next

    yield* f.tools.answer(f.host, "unknown", answered)
    yield* f.tools.answer("another-host", callId, answered)
    yield* watcher.end

    assert.deepStrictEqual(yield* Fiber.join(call), lostConnection)
  }),
)

it.effect("registers nothing when offered the tools it already serves", () =>
  Effect.gen(function* () {
    const f = yield* relay
    yield* f.tools.offer(f.host, [tool("list_queue")])
    const registered = f.server.tools[0]

    yield* f.tools.offer(f.host, [tool("list_queue")])

    assert.strictEqual(f.server.tools[0], registered)
    assert.equal(f.server.tools.length, 1)
  }),
)
