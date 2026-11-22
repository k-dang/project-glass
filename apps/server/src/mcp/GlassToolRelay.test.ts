import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import { Context, Effect, Layer, Predicate, Schema } from "effect"
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai"
import { SqlClient } from "effect/sql"
import { migrationLoader } from "../Migrations"
import type { RelayedToolCall } from "../agentHost/protocol"
import { GlassToolRelay, refused, ToolCallOrigin } from "./GlassToolRelay"
import { McpCaller } from "./McpCredentials"
import { forThreadsOnThisDevice } from "./toolAudience"
import { wideEvents } from "../wideEvents"

const named = (text: string) => new McpSchema.CallToolResult({ content: [{ type: "text", text }] })

const thread = (id: string, sandboxProvider: string | null, reviewBrief: string | null) => ({
  id,
  name: id,
  owner: "glass-demo",
  repo: "greeter",
  base_branch: "main",
  harness: "pi",
  folder: id,
  created_at: "2026-11-20T00:00:00.000Z",
  sandbox_provider: sandboxProvider,
  review_brief: reviewBrief,
})

const Say = Toolkit.make(
  Tool.make("say", {
    parameters: Schema.Struct({ message: Schema.String }),
    success: Schema.String,
  }),
)

const relay = Effect.gen(function* () {
  const context = yield* Layer.build(
    GlassToolRelay.layer.pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provideMerge(
        SqliteMigrator.layer({ loader: migrationLoader }).pipe(
          Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
        ),
      ),
    ),
  )

  const sql = Context.get(context, SqlClient.SqlClient)

  yield* sql`INSERT INTO thread ${sql.insert([
    thread("local", null, null),
    thread("sandboxed", "fake", null),
    thread("review", null, "{}"),
  ])}`

  yield* Context.get(context, McpServer.McpServer).addTool({
    tool: new McpSchema.Tool({ name: "caller", inputSchema: { type: "object", properties: {} } }),
    annotations: Context.empty(),
    handle: () =>
      McpCaller.current.pipe(
        Effect.map((caller) =>
          named(Predicate.isTagged(caller, "Thread") ? caller.threadId : caller._tag),
        ),
      ),
  })

  yield* McpServer.registerToolkit(Say).pipe(
    Effect.provide(Say.toLayer({ say: ({ message }) => Effect.succeed(`Said ${message.length}`) })),
    Effect.provideContext(context),
  )

  const glassToolRelay = Context.get(context, GlassToolRelay)

  return (
    origin: ToolCallOrigin,
    threadId: string,
    call: Pick<RelayedToolCall, "name" | "arguments"> = { name: "caller", arguments: {} },
  ) => glassToolRelay.answer(origin, { callId: "call", threadId, ...call })
})

it.effect("refuses a Sandbox's call stamped with another Thread", () =>
  Effect.gen(function* () {
    const answer = yield* relay

    assert.deepStrictEqual(
      yield* answer(ToolCallOrigin.Sandbox({ threadId: "sandboxed" }), "local"),
      refused,
    )
  }),
)

it.effect(
  "refuses this device's call for a Sandbox's, an Agent review's or an unknown Thread",
  () =>
    Effect.gen(function* () {
      const answer = yield* relay

      assert.deepStrictEqual(
        yield* Effect.forEach(["sandboxed", "review", "unknown"], (id) =>
          answer(ToolCallOrigin.ThisDevice(), id),
        ),
        [refused, refused, refused],
      )
    }),
)

it.effect("calls the tool as the Thread each origin answers for", () =>
  Effect.gen(function* () {
    const answer = yield* relay

    assert.deepStrictEqual(
      [
        yield* answer(ToolCallOrigin.Sandbox({ threadId: "sandboxed" }), "sandboxed"),
        yield* answer(ToolCallOrigin.ThisDevice(), "local"),
      ],
      [named("sandboxed"), named("local")],
    )
  }),
)

it.effect(
  "logs each call as one unit, with its caller and whether it failed but not its arguments",
  () =>
    Effect.gen(function* () {
      const answer = yield* relay
      const lines: Array<string> = []
      const said = { name: "say", arguments: { message: "the user's private words" } }

      yield* Effect.all([
        answer(ToolCallOrigin.ThisDevice(), "local", said),
        answer(ToolCallOrigin.ThisDevice(), "sandboxed", said),
      ]).pipe(Effect.provide(wideEvents("backend", (line) => lines.push(line))))

      assert.notInclude(lines.join(""), "private words")
      assert.deepStrictEqual(
        lines.map((line) => {
          const { event, tool, caller_id, tool_failed } = JSON.parse(line)

          return { event, tool, caller_id, tool_failed }
        }),
        [
          { event: "GlassToolRelay.answer", tool: "say", caller_id: "local", tool_failed: false },
          {
            event: "GlassToolRelay.answer",
            tool: "say",
            caller_id: "sandboxed",
            tool_failed: true,
          },
        ],
      )
    }),
)

it.effect(
  "offers a host on this device its tools for this device, and a Sandbox's host none of them",
  () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        GlassToolRelay.layer.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
        ),
      )

      const server = Context.get(context, McpServer.McpServer)

      for (const [name, annotations] of [
        ["anywhere", Context.empty()],
        ["this_device", forThreadsOnThisDevice],
      ] as const)
        yield* server.addTool({
          tool: new McpSchema.Tool({ name, inputSchema: { type: "object", properties: {} } }),
          annotations,
          handle: () => Effect.succeed(named(name)),
        })

      const glassToolRelay = Context.get(context, GlassToolRelay)
      yield* glassToolRelay.toolsRegistered

      const offered = (origin: ToolCallOrigin) =>
        glassToolRelay.toolsFor(origin).pipe(Effect.map((tools) => tools.map(({ name }) => name)))

      assert.deepStrictEqual(yield* offered(ToolCallOrigin.ThisDevice()), [
        "anywhere",
        "this_device",
      ])
      assert.deepStrictEqual(yield* offered(ToolCallOrigin.Sandbox({ threadId: "sandboxed" })), [
        "anywhere",
      ])
    }),
)
