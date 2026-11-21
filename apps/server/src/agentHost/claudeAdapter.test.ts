import { assert, it } from "@effect/vitest"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Redacted, Stream } from "effect"
import { claudeAdapter, type ClaudeQuery } from "./claudeAdapter"
import { type GlassToolsAccess, WorkRole } from "./protocol"
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
