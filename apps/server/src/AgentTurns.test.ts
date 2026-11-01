import { assert, it } from "@effect/vitest"
import {
  nothingUnsent,
  type Transcript,
  TurnDone,
  type TurnEnding,
  TurnEnded,
  TurnFailed,
  TurnInterrupted,
  TurnStopped,
} from "@glass/contracts"
import { DateTime, Effect } from "effect"
import { agentServicesFixture } from "../test/agentServicesFixture"
import { eventually } from "../test/eventually"

type Fixture = Effect.Success<typeof agentServicesFixture>

type StartedTurn = Effect.Success<Fixture["started"]>

const end = Effect.fnUntraced(function* (
  turn: StartedTurn,
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

const queuedMessages = ({ queued }: Transcript) => queued.map(({ message }) => message)

const endings = ({ turns }: Transcript) =>
  turns.map(({ message, ended }) => ({ message, ending: ended?.ending._tag }))

const say = (message: string) => ({ message, images: [] })

it.live(
  "queues messages sent while a Turn runs, starting them in order as Turns end, except a cancelled one",
  () =>
    Effect.gen(function* () {
      const f = yield* agentServicesFixture
      const agent = yield* f.create()
      const first = yield* f.started

      for (const message of ["Second", "Third", "Fourth"])
        yield* f.agents.send(agent.id, say(message))

      const waiting = yield* f.transcript(agent.id, ({ queued }) => queued.length === 3)
      assert.deepStrictEqual(queuedMessages(waiting), ["Second", "Third", "Fourth"])
      yield* f.agents.cancelQueued(agent.id, waiting.queued[1]?.id ?? "")

      yield* end(first)
      const second = yield* f.started
      assert.equal(second.input.message, "Second")
      yield* end(second)
      const fourth = yield* f.started
      assert.equal(fourth.input.message, "Fourth")
      yield* end(fourth)

      const done = yield* f.transcript(agent.id, settled(3))
      assert.deepStrictEqual(endings(done), [
        { message: "Start", ending: "Done" },
        { message: "Second", ending: "Done" },
        { message: "Fourth", ending: "Done" },
      ])
      assert.deepStrictEqual(done.queued, [])
    }),
)

it.live(
  "keeps Queued messages when a relaunch interrupts the Turn, to send when the user chooses",
  () =>
    Effect.gen(function* () {
      const f = yield* agentServicesFixture
      const agent = yield* f.create()
      yield* f.started
      yield* f.agents.send(agent.id, say("Again"))
      yield* f.transcript(agent.id, ({ queued }) => queued.length === 1)

      const { agents } = yield* f.restart
      const interrupted = yield* f.transcript(agent.id, settled(1), agents)
      assert.deepStrictEqual(interrupted.turns[0]?.ended?.ending, TurnInterrupted.make({}))
      assert.deepStrictEqual(queuedMessages(interrupted), ["Again"])

      yield* agents.sendQueued(agent.id, interrupted.queued[0]?.id ?? "")
      const again = yield* f.started
      assert.equal(again.input.message, "Again")
      assert.equal(again.agentId, agent.id)
    }),
)

it.live(
  "stops a Turn, putting the Steers the program hadn't taken in before the Queued messages",
  () =>
    Effect.gen(function* () {
      const f = yield* agentServicesFixture
      const agent = yield* f.create()
      const turn = yield* f.started
      yield* f.agents.send(agent.id, say("Later"))
      yield* f.agents.steer(agent.id, say("Also this"))
      yield* f.leaveOnStop([say("Also this")])

      yield* f.agents.stop(agent.id)
      assert.deepStrictEqual(f.stops, [agent.id])
      yield* end(turn, TurnStopped.make({}))

      const stopped = yield* f.transcript(
        agent.id,
        (transcript) => settled(1)(transcript) && transcript.queued.length === 2,
      )

      assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))
      assert.deepStrictEqual(queuedMessages(stopped), ["Also this", "Later"])
    }),
)

it.live("stops a Turn whose program is still starting, which never gets the message", () =>
  Effect.gen(function* () {
    const f = yield* agentServicesFixture
    yield* f.holdStart
    const agent = yield* f.create()
    yield* eventually(Effect.sync(() => assert.deepStrictEqual(f.starts, [agent.id])))

    yield* f.agents.stop(agent.id)
    const stopped = yield* f.transcript(agent.id, settled(1))
    assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))

    yield* f.releaseStart
    yield* f.agents.send(agent.id, say("Next"))
    assert.equal((yield* f.started).input.message, "Next")
  }),
)

it.live("keeps an Agent's unsent message across a relaunch until it is cleared", () =>
  Effect.gen(function* () {
    const f = yield* agentServicesFixture
    const agent = yield* f.create()
    const unsent = { message: "Half a thought", images: [] }
    yield* f.agents.saveUnsent(agent.id, unsent)

    const { agents } = yield* f.restart
    const kept = yield* agents.unsent(agent.id)
    assert.deepStrictEqual({ message: kept.message, images: kept.images }, unsent)

    yield* agents.saveUnsent(agent.id, nothingUnsent)
    const cleared = yield* agents.unsent(agent.id)
    assert.deepStrictEqual({ message: cleared.message, images: cleared.images }, nothingUnsent)
  }),
)

it.live("starts an Agent's program again for the next message after it exits", () =>
  Effect.gen(function* () {
    const f = yield* agentServicesFixture
    const agent = yield* f.create()
    const turn = yield* f.started
    yield* end(turn, TurnFailed.make({ reason: "The program stopped" }))
    yield* f.exit(agent.id)
    yield* f.transcript(agent.id, settled(1))

    yield* f.agents.send(agent.id, say("Try again"))
    assert.equal((yield* f.started).input.message, "Try again")
    assert.deepStrictEqual(f.starts, [agent.id, agent.id])
  }),
)
