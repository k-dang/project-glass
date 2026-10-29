import { assert, it } from "@effect/vitest"
import {
  applyTranscriptUpdate,
  emptyTranscript,
  SandboxPlace,
  SandboxProviderInfo,
  TextPart,
  type Turn,
  TurnCutOff,
  TurnDone,
  TurnStopped,
} from "@glass/contracts"
import { Effect, Option, Predicate, Stream } from "effect"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { vi } from "vite-plus/test"
import { agentsFixture, lastText, repository, settled } from "../test/agentsFixture"
import { gitIn } from "../test/gitRepositories"

vi.setConfig({ testTimeout: 30_000 })

vi.stubEnv("PI_OFFLINE", "1")

it.live(
  "starts an Agent in a Sandbox, showing each step of making it until the first message runs there",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({ output: "Hello from the Sandbox" })

      assert.deepStrictEqual(yield* f.client.ListSandboxProviders(), [
        new SandboxProviderInfo({ id: "fake", name: "Fake Sandboxes" }),
      ])

      f.sandboxes.configure({ holdAt: "Creating the Sandbox" })
      const agent = yield* f.startSandbox()
      assert.deepStrictEqual(
        { place: agent.place, repository: agent.repository },
        { place: SandboxPlace.make({ providerId: "fake" }), repository },
      )

      const statuses: Array<string | null> = []

      const [turn] = yield* f.client.WatchTranscript({ agentId: agent.id }).pipe(
        Stream.scan(() => emptyTranscript, applyTranscriptUpdate),
        Stream.tap(({ status }) =>
          Effect.sync(() => {
            if (statuses.at(-1) === status) return
            statuses.push(status)

            if (status === "Creating the Sandbox") f.sandboxes.configure({})
          }),
        ),
        Stream.filter(({ turns }) => settled(1)(turns)),
        Stream.runHead,
        Effect.map((found) => Option.getOrThrow(found).turns),
        Effect.timeout("30 seconds"),
      )

      assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
      assert.deepStrictEqual(lastText(turn), TextPart.make({ text: "Hello from the Sandbox" }))
      assert.deepStrictEqual(
        statuses.filter((status) => status !== null),
        ["Creating the Sandbox", "Cloning the repository", "Starting the agent"],
      )
      assert.isNull(statuses.at(-1))

      const clone = join(f.sandboxes.sandboxFolder(agent.id), repository.repo)
      assert.equal(gitIn(clone, "branch", "--show-current"), agent.name)
    }),
)

it.live("Steers and stops an Agent's Turns in its Sandbox, and shows its changes there", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Done.", hang: true })
    const agent = yield* f.startSandbox("Start")
    yield* f.model.received(1)

    yield* f.steer(agent.id, "Change course")
    yield* f.model.release({
      output: ({ messages }) =>
        JSON.stringify(messages).includes("Change course") ? "Changed." : "Started.",
    })

    const [steered] = yield* f.transcript(agent.id, settled(1))
    assert.deepStrictEqual(
      steered?.parts.map((part) => (Predicate.isTagged(part, "Text") ? part.text : part._tag)),
      ["Started.", "Steer", "Changed."],
    )

    yield* f.model.configure({ hang: true })
    yield* f.send(agent.id, "Keep going")
    yield* f.client.StopTurn({ agentId: agent.id })

    const [, stopped] = yield* f.transcript(agent.id, settled(2))
    assert.deepStrictEqual(stopped?.ended?.ending, TurnStopped.make({}))

    writeFileSync(join(f.sandboxes.sandboxFolder(agent.id), repository.repo, "notes.txt"), "hi\n")

    const files = yield* f.client.GetAgentChanges({ agentId: agent.id })
    assert.deepStrictEqual(
      files.map(({ changeType, path }) => `${changeType} ${path}`),
      ["added notes.txt"],
    )
  }),
)

it.live("warns before removing a Sandbox Agent with uncommitted work in its Sandbox", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Done." })
    const agent = yield* f.startSandbox()
    yield* f.transcript(agent.id, settled(1))

    const clean = yield* f.client.GetRemovalWarnings({ agentId: agent.id })
    assert.equal(clean.uncommittedChanges, "none")

    writeFileSync(join(f.sandboxes.sandboxFolder(agent.id), repository.repo, "notes.txt"), "hi\n")
    const dirty = yield* f.client.GetRemovalWarnings({ agentId: agent.id })
    assert.equal(dirty.uncommittedChanges, "some")

    process.kill(f.sandboxes.hostPid(agent.id), "SIGKILL")
    const unreachable = yield* f.client.GetRemovalWarnings({ agentId: agent.id })
    assert.equal(unreachable.uncommittedChanges, "unchecked")
  }),
)

const failedReason = (turn: Turn | undefined) => {
  const ending = turn?.ended?.ending

  return Predicate.isTagged(ending, "Failed") ? ending.reason : ending?._tag
}

it.live("deletes a Sandbox that fails part-way, failing the first message safely", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Hello" })
    f.sandboxes.configure({ failAt: "Cloning the repository" })
    const agent = yield* f.startSandbox()

    const [turn] = yield* f.transcript(agent.id, settled(1))
    assert.equal(
      failedReason(turn),
      "Couldn't create the Sandbox. Try again; Glass's backend log has the details.",
    )
    assert.isFalse(existsSync(f.sandboxes.sandboxFolder(agent.id)))
  }),
)

it.live("fails with the login a Sandbox needs and the command that fixes it", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Hello" })
    f.sandboxes.configure({ missingLogin: { login: "fake-cloud", fix: "fake-cloud login" } })
    const agent = yield* f.startSandbox()

    const [turn] = yield* f.transcript(agent.id, settled(1))
    assert.equal(
      failedReason(turn),
      "Fake Sandboxes needs your fake-cloud login. Run fake-cloud login, then try again.",
    )
  }),
)

it.live("keeps an Agent whose Sandbox can't be deleted yet, saying which login that needs", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Hello" })
    const agent = yield* f.startSandbox()
    yield* f.transcript(agent.id, settled(1))

    f.sandboxes.configure({ missingLogin: { login: "fake-cloud", fix: "fake-cloud login" } })
    const refused = yield* f.client.RemoveAgent({ agentId: agent.id }).pipe(Effect.flip)
    assert.equal(
      refused.message,
      "Fake Sandboxes needs your fake-cloud login. Run fake-cloud login, then try again.",
    )
    assert.deepStrictEqual(
      (yield* f.agents).map(({ id }) => id),
      [agent.id],
    )
    assert.isTrue(existsSync(f.sandboxes.sandboxFolder(agent.id)))

    f.sandboxes.configure({})
    yield* f.client.RemoveAgent({ agentId: agent.id })
    assert.deepStrictEqual(yield* f.agents, [])
    assert.isFalse(existsSync(f.sandboxes.sandboxFolder(agent.id)))
  }),
)

it.live(
  "refuses a Sandbox when there's no room, and makes one when the message is sent again",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({ output: "Hello" })
      f.sandboxes.configure({ noCapacity: "Fake Sandboxes are full." })
      const agent = yield* f.startSandbox()

      const [refused] = yield* f.transcript(agent.id, settled(1))
      assert.equal(failedReason(refused), "Fake Sandboxes are full. Try again in a little while.")

      f.sandboxes.configure({})
      yield* f.send(agent.id, "Try again")

      const [, retried] = yield* f.transcript(agent.id, settled(2))
      assert.deepStrictEqual(retried?.ended?.ending, TurnDone.make({}))
    }),
)

it.live("deletes a Sandbox still being made when its Agent is removed", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Hello" })
    f.sandboxes.configure({ holdAt: "Cloning the repository" })
    const agent = yield* f.startSandbox()

    yield* f.watch(agent.id, ({ status }) => status === "Cloning the repository")
    assert.isTrue(existsSync(f.sandboxes.sandboxFolder(agent.id)))

    yield* f.client.RemoveAgent({ agentId: agent.id })
    assert.isFalse(existsSync(f.sandboxes.sandboxFolder(agent.id)))
  }),
)

it.live("deletes a Sandbox still being made when Glass quits, and makes a new one after", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Hello" })
    f.sandboxes.configure({ holdAt: "Cloning the repository" })
    const agent = yield* f.startSandbox()

    yield* f.watch(agent.id, ({ status }) => status === "Cloning the repository")

    const relaunched = yield* f.restart
    assert.isFalse(existsSync(f.sandboxes.sandboxFolder(agent.id)))

    f.sandboxes.configure({})
    yield* relaunched.SendMessage({ agentId: agent.id, message: "Again", images: [] })

    const [, again] = yield* f.transcript(agent.id, settled(2), relaunched)
    assert.deepStrictEqual(again?.ended?.ending, TurnDone.make({}))
  }),
)

it.live(
  "connects to a Sandbox's host again after a dropped connection, catching up on what it missed",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({ output: "Done.", hang: true })
      const agent = yield* f.startSandbox("Start")
      yield* f.model.received(1)

      f.sandboxes.dropConnections(agent.id)
      yield* f.model.release({ output: "Finished while you were away." })
      yield* Effect.sleep("300 millis")
      f.sandboxes.reconnect(agent.id)

      const [turn] = yield* f.transcript(agent.id, settled(1))
      assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
      assert.deepStrictEqual(
        lastText(turn),
        TextPart.make({ text: "Finished while you were away." }),
      )
    }),
)

it.live("cuts off only the running Turn of an Agent whose Sandbox host is lost", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Done.", hang: true })
    const local = yield* f.start("Locally")
    const sandboxed = yield* f.startSandbox("In the Sandbox")
    yield* f.model.received(2)

    process.kill(f.sandboxes.hostPid(sandboxed.id), "SIGKILL")

    const [lost] = yield* f.transcript(sandboxed.id, settled(1))
    assert.deepStrictEqual(lost?.ended?.ending, TurnCutOff.make({}))

    yield* f.model.release({ output: "Done." })

    const [kept] = yield* f.transcript(local.id, settled(1))
    assert.deepStrictEqual(kept?.ended?.ending, TurnDone.make({}))
  }),
)
