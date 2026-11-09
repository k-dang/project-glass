import { assert, it } from "@effect/vitest"
import {
  ChangedFile,
  FollowedRepository,
  SandboxPlace,
  SandboxProviderInfo,
  type SandboxStatus,
  TextPatch,
  type Transcript,
  TurnDone,
  type TurnEnding,
  TurnEnded,
  TurnStopped,
} from "@glass/contracts"
import { DateTime, Effect, Option, Predicate, Stream } from "effect"
import { TestClock } from "effect/testing"
import { resolve } from "node:path"
import { agentServicesFixture } from "../test/agentServicesFixture"
import { eventually } from "../test/eventually"
import { steps } from "../test/inProcessSandboxes"

type Fixture = Effect.Success<typeof agentServicesFixture>

const sandbox = SandboxPlace.make({ providerId: "fake" })

const end = Effect.fnUntraced(function* (
  turn: Effect.Success<Fixture["started"]>,
  ending: TurnEnding = TurnDone.make({}),
) {
  yield* turn.emit(
    TurnEnded.make({ turnId: turn.turnId, ended: { at: yield* DateTime.now, ending } }),
  )
})

const settled =
  (count: number) =>
  ({ turns }: Transcript) =>
    turns.length === count && turns.every((turn) => turn.ended !== null)

const failedReason = ({ turns }: Transcript) => {
  const ending = turns.at(-1)?.ended?.ending

  return Predicate.isTagged(ending, "Failed") ? ending.reason : ending?._tag
}

const say = (message: string) => ({ message, images: [] })

const createSandboxed = (f: Fixture) => f.create(null, "pi", sandbox)

const removed = (f: Fixture, agentId: string) =>
  eventually(Effect.sync(() => assert.include(f.sandboxes.events, `removed ${agentId}`)))

it.live("shows each step of making a Sandbox, then runs the first message in it", () =>
  Effect.gen(function* () {
    const f = yield* agentServicesFixture

    assert.deepStrictEqual(f.sandboxProviders, [
      new SandboxProviderInfo({
        id: "fake",
        name: "Fake Sandboxes",
        engines: ["claude-code", "pi"],
      }),
    ])

    f.sandboxes.configure({ holdAt: steps[0] })
    const agent = yield* createSandboxed(f)
    assert.deepStrictEqual(agent.place, sandbox)

    for (const [index, step] of steps.entries()) {
      yield* f.transcript(agent.id, ({ status }) => status === step)
      const next = steps[index + 1]
      f.sandboxes.configure(next === undefined ? {} : { holdAt: next })
    }

    const turn = yield* f.started
    assert.equal(turn.agentId, agent.id)
    yield* end(turn)

    const done = yield* f.transcript(agent.id, settled(1))
    assert.isNull(done.status)
    assert.deepStrictEqual(done.turns[0]?.ended?.ending, TurnDone.make({}))
  }),
)

it.live("offers a Sandbox only the Agent programs its provider runs", () =>
  Effect.gen(function* () {
    const f = yield* agentServicesFixture
    f.sandboxes.configure({ engines: ["pi"] })
    const { agents, sandboxProviders } = yield* f.restart

    assert.deepStrictEqual(sandboxProviders, [
      new SandboxProviderInfo({ id: "fake", name: "Fake Sandboxes", engines: ["pi"] }),
    ])

    const refused = yield* agents
      .create({
        repository: new FollowedRepository({ owner: "glass-test", repo: "greeter" }),
        baseBranch: "main",
        message: "Start",
        images: [],
        engine: "claude-code",
        model: null,
        effort: null,
        permissionMode: null,
        place: sandbox,
        skillPacks: [],
      })
      .pipe(Effect.flip)

    assert.equal(refused.message, "This place doesn't run that Agent program. Pick another.")
  }),
)

it.live("deletes a Sandbox that fails part-way, failing the first message safely", () =>
  Effect.gen(function* () {
    const f = yield* agentServicesFixture
    f.sandboxes.configure({ failAt: steps[0] })
    const agent = yield* createSandboxed(f)

    const failed = yield* f.transcript(agent.id, settled(1))
    assert.equal(
      failedReason(failed),
      "Couldn't create the Sandbox. Try again; Glass's backend log has the details.",
    )
    yield* removed(f, agent.id)
  }),
)

it.live("fails with the login a Sandbox needs and the command that fixes it", () =>
  Effect.gen(function* () {
    const f = yield* agentServicesFixture
    f.sandboxes.configure({ missingLogin: { login: "fake-cloud", fix: "fake-cloud login" } })
    const agent = yield* createSandboxed(f)

    assert.equal(
      failedReason(yield* f.transcript(agent.id, settled(1))),
      "Fake Sandboxes needs your fake-cloud login. Run fake-cloud login, then try again.",
    )
  }),
)

it.live(
  "refuses a Sandbox when there's no room, and makes one when the message is sent again",
  () =>
    Effect.gen(function* () {
      const f = yield* agentServicesFixture
      f.sandboxes.configure({ noCapacity: "Fake Sandboxes are full." })
      const agent = yield* createSandboxed(f)

      assert.equal(
        failedReason(yield* f.transcript(agent.id, settled(1))),
        "Fake Sandboxes are full. Try again in a little while.",
      )

      f.sandboxes.configure({})
      yield* f.agents.send(agent.id, say("Try again"))
      yield* end(yield* f.started)
      assert.equal(failedReason(yield* f.transcript(agent.id, settled(2))), "Done")
    }),
)

it.live("keeps an Agent whose Sandbox can't be deleted yet, saying which login that needs", () =>
  Effect.gen(function* () {
    const f = yield* agentServicesFixture
    const agent = yield* createSandboxed(f)
    yield* end(yield* f.started)
    yield* f.transcript(agent.id, settled(1))

    f.sandboxes.configure({ missingLogin: { login: "fake-cloud", fix: "fake-cloud login" } })
    const refused = yield* f.agents.remove(agent.id).pipe(Effect.flip)
    assert.equal(
      refused.message,
      "Fake Sandboxes needs your fake-cloud login. Run fake-cloud login, then try again.",
    )
    assert.notInclude(f.sandboxes.events, `removed ${agent.id}`)
    yield* f.agents.unsent(agent.id)

    f.sandboxes.configure({})
    yield* f.agents.remove(agent.id)
    assert.include(f.sandboxes.events, `removed ${agent.id}`)
  }),
)

it.live("ends a Sandbox's agent host before deleting the Sandbox", () =>
  Effect.gen(function* () {
    const f = yield* agentServicesFixture
    const agent = yield* createSandboxed(f)
    yield* end(yield* f.started)
    yield* f.transcript(agent.id, settled(1))

    yield* f.agents.remove(agent.id)
    assert.deepStrictEqual(f.sandboxes.events, [`ended ${agent.id}`, `removed ${agent.id}`])
  }),
)

it.live("deletes a Sandbox still being made when its Agent is removed", () =>
  Effect.gen(function* () {
    const f = yield* agentServicesFixture
    f.sandboxes.configure({ holdAt: steps[0] })
    const agent = yield* createSandboxed(f)
    yield* f.transcript(agent.id, ({ status }) => status === steps[0])

    yield* f.agents.remove(agent.id)
    yield* removed(f, agent.id)
  }),
)

it.live("deletes a Sandbox still being made when Glass quits, and makes a new one after", () =>
  Effect.gen(function* () {
    const f = yield* agentServicesFixture
    f.sandboxes.configure({ holdAt: steps[0] })
    const agent = yield* createSandboxed(f)
    yield* f.transcript(agent.id, ({ status }) => status === steps[0])

    const { agents } = yield* f.restart
    yield* removed(f, agent.id)

    f.sandboxes.configure({})
    yield* agents.send(agent.id, say("Again"))
    const again = yield* f.started
    assert.equal(again.input.message, "Again")
    yield* end(again)
    assert.equal(failedReason(yield* f.transcript(agent.id, settled(2), agents)), "Done")
  }),
)

it.live("Steers and stops an Agent's Turns in its Sandbox, and shows its changes there", () =>
  Effect.gen(function* () {
    const f = yield* agentServicesFixture
    const agent = yield* createSandboxed(f)
    const turn = yield* f.started

    yield* f.agents.steer(agent.id, say("Change course"))
    assert.deepStrictEqual(f.steers, [{ agentId: agent.id, message: "Change course" }])

    yield* f.agents.stop(agent.id)
    assert.deepStrictEqual(f.stops, [agent.id])
    yield* end(turn, TurnStopped.make({}))
    yield* f.transcript(agent.id, settled(1))

    const notes = new ChangedFile({
      path: "notes.txt",
      previousPath: null,
      changeType: "added",
      additions: 1,
      deletions: 0,
      patch: TextPatch.make({ hunks: "@@ -0,0 +1 @@\n+hi" }),
    })

    yield* f.setChanges({ files: [notes], uncommitted: true })
    assert.deepStrictEqual(yield* f.agents.changes(agent.id), [notes])
    assert.deepStrictEqual(f.changesAsked, [
      { folder: resolve("greeter"), baseRef: "refs/remotes/origin/main" },
    ])
  }),
)

it.live("warns before removing a Sandbox Agent with uncommitted work in its Sandbox", () =>
  Effect.gen(function* () {
    const f = yield* agentServicesFixture
    const agent = yield* createSandboxed(f)
    yield* end(yield* f.started)
    yield* f.transcript(agent.id, settled(1))

    assert.equal((yield* f.agents.removalWarnings(agent.id)).uncommittedChanges, "none")

    yield* f.setChanges({ files: [], uncommitted: true })
    assert.equal((yield* f.agents.removalWarnings(agent.id)).uncommittedChanges, "some")

    yield* f.sandboxes.stopHost(agent.id)
    assert.equal((yield* f.agents.removalWarnings(agent.id)).uncommittedChanges, "unchecked")
  }),
)

const sandboxOf = (agents: Fixture["agents"], agentId: string) =>
  agents.watch().pipe(
    Stream.map((listed) => listed.find(({ id }) => id === agentId)?.sandbox ?? null),
    Stream.filter((status): status is SandboxStatus => status !== null),
  )

it.live(
  "makes an Agent read-only once its Sandbox is deleted, and removes it without a warning",
  () =>
    Effect.gen(function* () {
      const f = yield* agentServicesFixture
      const agent = yield* createSandboxed(f)
      yield* end(yield* f.started)
      yield* f.transcript(agent.id, settled(1))

      yield* f.sandboxes.reclaim(agent.id)
      const relaunched = yield* f.restart
      yield* sandboxOf(relaunched.agents, agent.id).pipe(
        Stream.filter(({ reach }) => reach === "deleted"),
        Stream.runHead,
      )

      const refused = yield* relaunched.agents.send(agent.id, say("Still there?")).pipe(Effect.flip)
      assert.equal(
        refused.message,
        "This Agent's Sandbox was deleted, so it can't take messages. Its transcript stays until you remove the Agent.",
      )

      const { agents } = yield* f.restart
      const [listed] = yield* agents.watch().pipe(Stream.runHead, Effect.map(Option.getOrThrow))
      assert.equal(listed?.sandbox?.reach, "deleted")
      assert.equal(failedReason(yield* f.transcript(agent.id, settled(1), agents)), "Done")
      assert.equal((yield* agents.removalWarnings(agent.id)).uncommittedChanges, "none")

      yield* agents.remove(agent.id)
      assert.deepStrictEqual(
        yield* agents.watch().pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
        [],
      )
    }),
)

it.effect(
  "extends a Sandbox ahead of expiry up to its cap, then makes its Agent read-only once it expires",
  () =>
    Effect.gen(function* () {
      const f = yield* agentServicesFixture
      f.sandboxes.configure({ extensionMillis: 1000, maxLifetimeMillis: 3000 })
      const agent = yield* createSandboxed(f)
      yield* end(yield* f.started)

      for (const expiry of [1000, 1500, 2000, 2500, 3000]) {
        yield* sandboxOf(f.agents, agent.id).pipe(
          Stream.filter(
            ({ expiresAt }) => expiresAt !== null && DateTime.toEpochMillis(expiresAt) === expiry,
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        )
        yield* TestClock.adjust(500)
      }

      const expired = yield* eventually(
        Effect.gen(function* () {
          yield* TestClock.adjust(500)

          const status = yield* sandboxOf(f.agents, agent.id).pipe(
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          )

          assert.equal(status.reach, "expired")

          return status
        }),
      )

      assert.equal(expired.expiresAt && DateTime.toEpochMillis(expired.expiresAt), 3000)

      const refused = yield* f.agents.send(agent.id, say("Still there?")).pipe(Effect.flip)
      assert.equal(
        refused.message,
        "This Agent's Sandbox expired, so it can't take messages. Its transcript stays until you remove the Agent.",
      )
    }),
)
