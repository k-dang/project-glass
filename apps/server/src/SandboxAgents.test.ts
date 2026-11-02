import { NodeSocket } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { RPC_PATH, TextPart, TurnCutOff, TurnDone } from "@glass/contracts"
import { Effect, Predicate, Stream } from "effect"
import { vi } from "vite-plus/test"
import { agentsFixture, claudeCode, lastText, settled } from "../test/agentsFixture"
import { AgentHostRpcs, HOST_TOKEN_HEADER } from "./agentHost/protocol"
import { connectRpcClient } from "./rpcSocket"

vi.stubEnv("PI_OFFLINE", "1")

it.live(
  "connects to a Sandbox's host again after a dropped connection, catching up on what it missed",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({})
      yield* f.claude.hold
      const agent = yield* f.startSandbox("Start", claudeCode)
      yield* f.claude.received(1)

      f.sandboxes.dropConnections(agent.id)
      yield* f.claude.release

      const { port, token } = f.sandboxes.host(agent.id)

      const witness = yield* connectRpcClient(AgentHostRpcs, `ws://127.0.0.1:${port}${RPC_PATH}`, {
        [HOST_TOKEN_HEADER]: token,
      }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor))

      yield* witness.WatchJournal({ after: 0 }).pipe(
        Stream.filter(({ event }) => Predicate.isTagged(event, "TurnEnded")),
        Stream.runHead,
      )

      const [missed] = yield* f.transcript(agent.id, (turns) => turns.length === 1)
      assert.isNull(missed?.ended)
      f.sandboxes.reconnect(agent.id)

      const [turn] = yield* f.transcript(agent.id, settled(1))
      assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
      assert.deepStrictEqual(lastText(turn), TextPart.make({ text: "Fake reply to: Start" }))
    }),
)

it.live("cuts off only the running Turn of an Agent whose Sandbox host is lost", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Done.", hang: true })
    const local = yield* f.start("Locally")
    const sandboxed = yield* f.startSandbox("In the Sandbox")
    yield* f.model.received(2)

    f.sandboxes.killHost(sandboxed.id)

    const [lost] = yield* f.transcript(sandboxed.id, settled(1))
    assert.deepStrictEqual(lost?.ended?.ending, TurnCutOff.make({}))

    yield* f.model.release({ output: "Done." })

    const [kept] = yield* f.transcript(local.id, settled(1))
    assert.deepStrictEqual(kept?.ended?.ending, TurnDone.make({}))
  }),
)
