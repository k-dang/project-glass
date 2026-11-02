import { NodeSocket } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { RemovalWarnings, RPC_PATH, TextPart, TurnCutOff, TurnDone } from "@glass/contracts"
import { Effect, Predicate, Stream } from "effect"
import { vi } from "vite-plus/test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { agentsFixture, claudeCode, lastText, repository, settled } from "../test/agentsFixture"
import { gitIn } from "../test/gitRepositories"
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

    yield* Effect.promise(() => f.sandboxes.killHost(sandboxed.id))

    const [lost] = yield* f.transcript(sandboxed.id, settled(1))
    assert.deepStrictEqual(lost?.ended?.ending, TurnCutOff.make({}))

    yield* f.model.release({ output: "Done." })

    const [kept] = yield* f.transcript(local.id, settled(1))
    assert.deepStrictEqual(kept?.ended?.ending, TurnDone.make({}))
  }),
)

it.live("fills in what a Sandbox Agent did while Glass was closed, once Glass opens again", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Started.", hang: true })
    const agent = yield* f.startSandbox("Start")
    yield* f.model.received(1)

    yield* f.quit
    yield* f.model.release({ output: "Finished." })
    const relaunched = yield* f.launch

    const [turn] = yield* f.transcript(agent.id, settled(1), relaunched)
    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepStrictEqual(
      turn?.parts.filter((part) => Predicate.isTagged(part, "Text")),
      [TextPart.make({ text: "Finished." })],
    )
  }),
)

it.live(
  "marks a Sandbox it can't reach unreachable without holding up local Agents, then fills in how its Turn ended",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({ output: "Done.", hang: true })
      const local = yield* f.start("Locally")
      const sandboxed = yield* f.startSandbox("In the Sandbox")
      yield* f.model.received(2)

      f.sandboxes.dropConnections(sandboxed.id)
      yield* f.sandboxStatus(sandboxed.id, ({ reach }) => reach === "unreachable")
      const [cutOff] = yield* f.transcript(sandboxed.id, settled(1))
      assert.deepStrictEqual(cutOff?.ended?.ending, TurnCutOff.make({}))

      yield* f.model.release({ output: "Done." })
      const [kept] = yield* f.transcript(local.id, settled(1))
      assert.deepStrictEqual(kept?.ended?.ending, TurnDone.make({}))

      f.sandboxes.reconnect(sandboxed.id)
      yield* f.sandboxStatus(sandboxed.id, ({ reach }) => reach === "reachable")

      const [filledIn] = yield* f.transcript(
        sandboxed.id,
        ([turn]) => turn?.ended?.ending._tag === "Done",
      )

      assert.deepStrictEqual(lastText(filledIn), TextPart.make({ text: "Done." }))
    }),
)

it.live("warns before removing a Sandbox Agent with work in its Sandbox that isn't on GitHub", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Done." })
    const agent = yield* f.startSandbox()
    yield* f.transcript(agent.id, settled(1))
    const clone = join(f.sandboxes.sandboxFolder(agent.id), repository.repo)

    const clean = yield* f.client.GetRemovalWarnings({ agentId: agent.id })
    assert.deepStrictEqual(
      clean,
      new RemovalWarnings({ uncommittedChanges: "none", unpushedCommits: [] }),
    )

    writeFileSync(join(clone, "notes.txt"), "hi\n")
    const dirty = yield* f.client.GetRemovalWarnings({ agentId: agent.id })
    assert.equal(dirty.uncommittedChanges, "some")

    gitIn(clone, "add", "notes.txt")
    gitIn(clone, "commit", "--quiet", "-m", "Add notes")
    const committed = yield* f.client.GetRemovalWarnings({ agentId: agent.id })
    assert.deepStrictEqual(
      committed.unpushedCommits.map(({ subject }) => subject),
      ["Add notes"],
    )
    assert.equal(committed.uncommittedChanges, "none")

    gitIn(clone, "push", "--quiet", "origin", agent.name)
    const pushed = yield* f.client.GetRemovalWarnings({ agentId: agent.id })
    assert.deepStrictEqual(pushed.unpushedCommits, [])
  }),
)

it.live("cuts off a Turn whose Sandbox host died while Glass was closed", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Done.", hang: true })
    const agent = yield* f.startSandbox("Start")
    yield* f.model.received(1)

    yield* f.quit
    yield* Effect.promise(() => f.sandboxes.killHost(agent.id))
    const relaunched = yield* f.launch

    yield* f.sandboxStatus(agent.id, ({ reach }) => reach === "unreachable", relaunched)
    const [turn] = yield* f.transcript(agent.id, settled(1), relaunched)
    assert.deepStrictEqual(turn?.ended?.ending, TurnCutOff.make({}))
  }),
)
