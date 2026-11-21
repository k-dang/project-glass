import { assert, it } from "@effect/vitest"
import {
  AgentStatusesChanged,
  Image,
  nothingUnsent,
  PartSet,
  TextPart,
  toDoMention,
  type Transcript,
  TurnDone,
  type TurnEnding,
  TurnEnded,
  TurnFailed,
  TurnInterrupted,
  TurnStopped,
} from "@glass/contracts"
import { DateTime, Effect } from "effect"
import { threadServicesFixture } from "../test/threadServicesFixture"
import { eventually } from "../test/eventually"
import { overBudget } from "./agentHost/HostThreads"
import { JournalBudget } from "./agentHost/Journal"

type Fixture = Effect.Success<typeof threadServicesFixture>

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
      const f = yield* threadServicesFixture
      const thread = yield* f.create()
      const first = yield* f.started

      for (const message of ["Second", "Third", "Fourth"])
        yield* f.threads.send(thread.id, say(message))

      const waiting = yield* f.transcript(thread.id, ({ queued }) => queued.length === 3)
      assert.deepStrictEqual(queuedMessages(waiting), ["Second", "Third", "Fourth"])
      yield* f.threads.cancelQueued(thread.id, waiting.queued[1]?.id ?? "")

      yield* end(first)
      const second = yield* f.started
      assert.equal(second.input.message, "Second")
      yield* end(second)
      const fourth = yield* f.started
      assert.equal(fourth.input.message, "Fourth")
      yield* end(fourth)

      const done = yield* f.transcript(thread.id, settled(3))
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
      const f = yield* threadServicesFixture
      const thread = yield* f.create()
      yield* f.started
      yield* f.threads.send(thread.id, say("Again"))
      yield* f.transcript(thread.id, ({ queued }) => queued.length === 1)

      const { threads } = yield* f.restart
      const interrupted = yield* f.transcript(thread.id, settled(1), threads)
      assert.deepStrictEqual(interrupted.turns[0]?.ended?.ending, TurnInterrupted.make({}))
      assert.deepStrictEqual(queuedMessages(interrupted), ["Again"])

      yield* threads.sendQueued(thread.id, interrupted.queued[0]?.id ?? "")
      const again = yield* f.started
      assert.equal(again.input.message, "Again")
      assert.equal(again.threadId, thread.id)
    }),
)

it.live(
  "stops a Turn, putting the Steers the harness hadn't taken in before the Queued messages",
  () =>
    Effect.gen(function* () {
      const f = yield* threadServicesFixture
      const thread = yield* f.create()
      const turn = yield* f.started
      yield* f.threads.send(thread.id, say("Later"))
      yield* f.threads.steer(thread.id, say("Also this"))
      yield* f.leaveOnStop([{ ...say("Also this"), context: null }])

      yield* f.threads.stop(thread.id)
      assert.deepStrictEqual(f.stops, [thread.id])
      yield* end(turn, TurnStopped.make({}))

      const stopped = yield* f.transcript(
        thread.id,
        (transcript) => settled(1)(transcript) && transcript.queued.length === 2,
      )

      assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))
      assert.deepStrictEqual(queuedMessages(stopped), ["Also this", "Later"])
    }),
)

it.live(
  "puts the Steers the harness hadn't taken in before the Queued messages when the host stops a Turn over its budget, once",
  () =>
    Effect.gen(function* () {
      const f = yield* threadServicesFixture.pipe(Effect.provideService(JournalBudget, 1_000))
      const thread = yield* f.create()
      const turn = yield* f.started
      yield* f.threads.send(thread.id, say("Later"))
      yield* f.threads.steer(thread.id, say("Also this"))
      const left = [{ ...say("Also this"), context: null }]
      yield* f.leaveOnStop(left)

      yield* turn.emit(
        PartSet.make({
          turnId: turn.turnId,
          index: 0,
          part: TextPart.make({ text: "a".repeat(2_000) }),
        }),
      )
      yield* eventually(Effect.sync(() => assert.deepStrictEqual(f.stops, [thread.id])))
      yield* end(turn, overBudget)

      const stopped = yield* f.transcript(
        thread.id,
        (transcript) => settled(1)(transcript) && transcript.queued.length === 2,
      )

      const ended = stopped.turns[0]?.ended
      assert.exists(ended)
      assert.deepStrictEqual(ended.ending, overBudget)
      assert.deepStrictEqual(queuedMessages(stopped), ["Also this", "Later"])

      yield* turn.emit({
        ...TurnEnded.make({ turnId: turn.turnId, ended }),
        steersNotTakenIn: left,
      })
      yield* turn.emit(AgentStatusesChanged.make({ agentStatuses: ["Replayed"] }))

      const replayed = yield* f.transcript(thread.id, ({ agentStatuses }) =>
        agentStatuses.includes("Replayed"),
      )

      assert.deepStrictEqual(queuedMessages(replayed), ["Also this", "Later"])
      assert.equal(replayed.turns.length, 1)
    }),
)

it.live("stops a Turn whose harness is still starting, which never gets the message", () =>
  Effect.gen(function* () {
    const f = yield* threadServicesFixture
    yield* f.holdStart
    const thread = yield* f.create()
    yield* eventually(Effect.sync(() => assert.deepStrictEqual(f.starts, [thread.id])))

    yield* f.threads.stop(thread.id)
    const stopped = yield* f.transcript(thread.id, settled(1))
    assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))

    yield* f.releaseStart
    yield* f.threads.send(thread.id, say("Next"))
    assert.equal((yield* f.started).input.message, "Next")
  }),
)

it.live("keeps a Thread's unsent message across a relaunch until it is cleared", () =>
  Effect.gen(function* () {
    const f = yield* threadServicesFixture
    const thread = yield* f.create()

    const unsent = {
      message: "Half a thought",
      images: [Image.make({ mediaType: "image/png", data: "iVBORw0KGgo=" })],
    }

    yield* f.threads.saveUnsent(thread.id, unsent)

    const { threads } = yield* f.restart
    const kept = yield* threads.unsent(thread.id)
    assert.deepStrictEqual({ message: kept.message, images: kept.images }, unsent)

    yield* threads.saveUnsent(thread.id, nothingUnsent)
    const cleared = yield* threads.unsent(thread.id)
    assert.deepStrictEqual({ message: cleared.message, images: cleared.images }, nothingUnsent)
  }),
)

it.live("starts a Thread's harness again for the next message after it exits", () =>
  Effect.gen(function* () {
    const f = yield* threadServicesFixture
    const thread = yield* f.create()
    const turn = yield* f.started
    yield* end(turn, TurnFailed.make({ reason: "The harness stopped" }))
    yield* f.exit(thread.id)
    yield* f.transcript(thread.id, settled(1))

    yield* f.threads.send(thread.id, say("Try again"))
    assert.equal((yield* f.started).input.message, "Try again")
    assert.deepStrictEqual(f.starts, [thread.id, thread.id])
  }),
)

it.live("lists what a Thread's harness runs as `/name` in the Thread's own folder", () =>
  Effect.gen(function* () {
    const f = yield* threadServicesFixture
    const thread = yield* f.create()

    const [command] = yield* f.threads.commands(thread.id)

    assert.equal(command?.name, "greet")
    assert.equal(command?.description, thread.name)
  }),
)

it.live("gives the agent each mentioned To-do's images apart from the user's own", () =>
  Effect.gen(function* () {
    const f = yield* threadServicesFixture
    const own = { mediaType: "image/png", data: "b3du" } as const
    const screenshot = { mediaType: "image/png", data: "c2hvdA==" } as const

    const [toDo] = yield* f.toDos.add("Fix spacing", "Looks off", [
      { ...screenshot, thumbnail: "dGh1bWI=", thumbnailMediaType: "image/png" },
    ])

    const thread = yield* f.create()
    yield* end(yield* f.started)
    yield* f.threads.send(thread.id, {
      message: `Do ${toDoMention(toDo!)}`,
      images: [own],
    })
    const turn = yield* f.started

    assert.deepStrictEqual(turn.input.images, [own])
    assert.deepStrictEqual(turn.input.mentionedImages, [screenshot])
  }),
)
