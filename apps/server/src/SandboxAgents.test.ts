import { NodeSocket } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { RPC_PATH, TextPart, TurnCutOff, TurnDone } from "@glass/contracts"
import { Effect, Predicate, Stream } from "effect"
import { agentsFixture, holding, lastText, settled } from "../test/agentsFixture"
import { AgentHostRpcs, HOST_TOKEN_HEADER } from "./agentHost/protocol"
import { connectRpcClient } from "./rpcSocket"

it.live(
  "connects to a Sandbox's host again after a dropped connection, catching up on what it missed",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const agent = yield* f.startSandbox("hold:start")
      yield* f.transcript(agent.id, holding)
      yield* Effect.promise(() => f.sandboxes.dropConnections(agent.id))
      yield* f.release("start")
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
      assert.deepStrictEqual(lastText(turn), TextPart.make({ text: "Reply to: hold:start" }))
    }),
)

it.live("cuts off only the running Turn of an Agent whose Sandbox host is lost", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    const local = yield* f.start("hold:local")
    const sandboxed = yield* f.startSandbox("hold:sandboxed")
    yield* f.transcript(local.id, holding)
    yield* f.transcript(sandboxed.id, holding)

    yield* Effect.promise(() => f.sandboxes.killHost(sandboxed.id))

    const [lost] = yield* f.transcript(sandboxed.id, settled(1))
    assert.deepStrictEqual(lost?.ended?.ending, TurnCutOff.make({}))

    yield* f.release("local")
    const [kept] = yield* f.transcript(local.id, settled(1))
    assert.deepStrictEqual(kept?.ended?.ending, TurnDone.make({}))
  }),
)

it.live("fills in what a Sandbox Agent did while Glass was closed, once Glass opens again", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    const agent = yield* f.startSandbox("hold:start")
    yield* f.transcript(agent.id, holding)

    yield* f.quit
    yield* f.release("start")
    const relaunched = yield* f.launch

    const [turn] = yield* f.transcript(agent.id, settled(1), relaunched)
    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepStrictEqual(
      turn?.parts.filter((part) => Predicate.isTagged(part, "Text")),
      [TextPart.make({ text: "Holding." }), TextPart.make({ text: "Reply to: hold:start" })],
    )
  }),
)

it.live(
  "marks a Sandbox it can't reach unreachable without holding up local Agents, then fills in how its Turn ended",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const local = yield* f.start("hold:local")
      const sandboxed = yield* f.startSandbox("hold:sandboxed")
      yield* f.transcript(local.id, holding)
      yield* f.transcript(sandboxed.id, holding)

      yield* Effect.promise(() => f.sandboxes.dropConnections(sandboxed.id))
      yield* f.sandboxStatus(sandboxed.id, ({ reach }) => reach === "unreachable")
      const [cutOff] = yield* f.transcript(sandboxed.id, settled(1))
      assert.deepStrictEqual(cutOff?.ended?.ending, TurnCutOff.make({}))

      yield* f.release("local")
      yield* f.release("sandboxed")
      const [kept] = yield* f.transcript(local.id, settled(1))
      assert.deepStrictEqual(kept?.ended?.ending, TurnDone.make({}))

      f.sandboxes.reconnect(sandboxed.id)
      yield* f.sandboxStatus(sandboxed.id, ({ reach }) => reach === "reachable")

      const [filledIn] = yield* f.transcript(
        sandboxed.id,
        ([turn]) => turn?.ended?.ending._tag === "Done",
      )

      assert.deepStrictEqual(
        lastText(filledIn),
        TextPart.make({ text: "Reply to: hold:sandboxed" }),
      )
    }),
)

it.live("cuts off a Turn whose Sandbox host died while Glass was closed", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    const agent = yield* f.startSandbox("hold:start")
    yield* f.transcript(agent.id, holding)

    yield* f.quit
    yield* Effect.promise(() => f.sandboxes.killHost(agent.id))
    const relaunched = yield* f.launch

    yield* f.sandboxStatus(agent.id, ({ reach }) => reach === "unreachable", relaunched)
    const [turn] = yield* f.transcript(agent.id, settled(1), relaunched)
    assert.deepStrictEqual(turn?.ended?.ending, TurnCutOff.make({}))
  }),
)
