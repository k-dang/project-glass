import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { claudeAdapter, type ClaudeQuery } from "./claudeAdapter"
import { WorkRole } from "./protocol"

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

    const adapter = yield* claudeAdapter("claude-test", {
      query: () => query,
      getSessionInfo: async () => undefined,
    }).pipe(Effect.provide(NodeFileSystem.layer))

    const failed = yield* adapter
      .start({
        folder: "checkout",
        conversation: "new",
        role: WorkRole.make({ skills: [] }),
        report: () => Effect.void,
      })
      .pipe(Effect.scoped, Effect.flip)

    assert.equal(failed._tag, "HostAgentError")
    assert.isTrue(closed)
  }),
)
