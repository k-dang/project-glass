import { assert, it } from "@effect/vitest"
import {
  ExtensionStatusesChanged,
  Image,
  nothingUnsent,
  PartSet,
  TextPart,
  type Transcript,
  TurnDone,
  type TurnEnding,
  TurnEnded,
  TurnFailed,
  TurnInterrupted,
  TurnStopped,
} from "@glass/contracts"
import { DateTime, Effect } from "effect"
import { conversationServicesFixture } from "../test/conversationServicesFixture"
import { eventually } from "../test/eventually"
import { overBudget } from "./agentHost/HostConversations"
import { JournalBudget } from "./agentHost/Journal"

type Fixture = Effect.Success<typeof conversationServicesFixture>

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
      const f = yield* conversationServicesFixture
      const conversation = yield* f.create()
      const first = yield* f.started

      for (const message of ["Second", "Third", "Fourth"])
        yield* f.conversations.send(conversation.id, say(message))

      const waiting = yield* f.transcript(conversation.id, ({ queued }) => queued.length === 3)
      assert.deepStrictEqual(queuedMessages(waiting), ["Second", "Third", "Fourth"])
      yield* f.conversations.cancelQueued(conversation.id, waiting.queued[1]?.id ?? "")

      yield* end(first)
      const second = yield* f.started
      assert.equal(second.input.message, "Second")
      yield* end(second)
      const fourth = yield* f.started
      assert.equal(fourth.input.message, "Fourth")
      yield* end(fourth)

      const done = yield* f.transcript(conversation.id, settled(3))
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
      const f = yield* conversationServicesFixture
      const conversation = yield* f.create()
      yield* f.started
      yield* f.conversations.send(conversation.id, say("Again"))
      yield* f.transcript(conversation.id, ({ queued }) => queued.length === 1)

      const { conversations } = yield* f.restart
      const interrupted = yield* f.transcript(conversation.id, settled(1), conversations)
      assert.deepStrictEqual(interrupted.turns[0]?.ended?.ending, TurnInterrupted.make({}))
      assert.deepStrictEqual(queuedMessages(interrupted), ["Again"])

      yield* conversations.sendQueued(conversation.id, interrupted.queued[0]?.id ?? "")
      const again = yield* f.started
      assert.equal(again.input.message, "Again")
      assert.equal(again.conversationId, conversation.id)
    }),
)

it.live(
  "stops a Turn, putting the Steers the harness hadn't taken in before the Queued messages",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationServicesFixture
      const conversation = yield* f.create()
      const turn = yield* f.started
      yield* f.conversations.send(conversation.id, say("Later"))
      yield* f.conversations.steer(conversation.id, say("Also this"))
      yield* f.leaveOnStop([{ ...say("Also this"), context: null }])

      yield* f.conversations.stop(conversation.id)
      assert.deepStrictEqual(f.stops, [conversation.id])
      yield* end(turn, TurnStopped.make({}))

      const stopped = yield* f.transcript(
        conversation.id,
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
      const f = yield* conversationServicesFixture.pipe(Effect.provideService(JournalBudget, 1_000))
      const conversation = yield* f.create()
      const turn = yield* f.started
      yield* f.conversations.send(conversation.id, say("Later"))
      yield* f.conversations.steer(conversation.id, say("Also this"))
      const left = [{ ...say("Also this"), context: null }]
      yield* f.leaveOnStop(left)

      yield* turn.emit(
        PartSet.make({
          turnId: turn.turnId,
          index: 0,
          part: TextPart.make({ text: "a".repeat(2_000) }),
        }),
      )
      yield* eventually(Effect.sync(() => assert.deepStrictEqual(f.stops, [conversation.id])))
      yield* end(turn, overBudget)

      const stopped = yield* f.transcript(
        conversation.id,
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
      yield* turn.emit(ExtensionStatusesChanged.make({ extensionStatuses: ["Replayed"] }))

      const replayed = yield* f.transcript(conversation.id, ({ extensionStatuses }) =>
        extensionStatuses.includes("Replayed"),
      )

      assert.deepStrictEqual(queuedMessages(replayed), ["Also this", "Later"])
      assert.equal(replayed.turns.length, 1)
    }),
)

it.live("stops a Turn whose harness is still starting, which never gets the message", () =>
  Effect.gen(function* () {
    const f = yield* conversationServicesFixture
    yield* f.holdStart
    const conversation = yield* f.create()
    yield* eventually(Effect.sync(() => assert.deepStrictEqual(f.starts, [conversation.id])))

    yield* f.conversations.stop(conversation.id)
    const stopped = yield* f.transcript(conversation.id, settled(1))
    assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))

    yield* f.releaseStart
    yield* f.conversations.send(conversation.id, say("Next"))
    assert.equal((yield* f.started).input.message, "Next")
  }),
)

it.live("keeps a Conversation's unsent message across a relaunch until it is cleared", () =>
  Effect.gen(function* () {
    const f = yield* conversationServicesFixture
    const conversation = yield* f.create()

    const unsent = {
      message: "Half a thought",
      images: [Image.make({ mediaType: "image/png", data: "iVBORw0KGgo=" })],
    }

    yield* f.conversations.saveUnsent(conversation.id, unsent)

    const { conversations } = yield* f.restart
    const kept = yield* conversations.unsent(conversation.id)
    assert.deepStrictEqual({ message: kept.message, images: kept.images }, unsent)

    yield* conversations.saveUnsent(conversation.id, nothingUnsent)
    const cleared = yield* conversations.unsent(conversation.id)
    assert.deepStrictEqual({ message: cleared.message, images: cleared.images }, nothingUnsent)
  }),
)

it.live("starts a Conversation's harness again for the next message after it exits", () =>
  Effect.gen(function* () {
    const f = yield* conversationServicesFixture
    const conversation = yield* f.create()
    const turn = yield* f.started
    yield* end(turn, TurnFailed.make({ reason: "The harness stopped" }))
    yield* f.exit(conversation.id)
    yield* f.transcript(conversation.id, settled(1))

    yield* f.conversations.send(conversation.id, say("Try again"))
    assert.equal((yield* f.started).input.message, "Try again")
    assert.deepStrictEqual(f.starts, [conversation.id, conversation.id])
  }),
)

it.live(
  "lists what a Conversation's harness runs as `/name` in the Conversation's own folder",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationServicesFixture
      const conversation = yield* f.create()

      const [command] = yield* f.conversations.commands(conversation.id)

      assert.equal(command?.name, "greet")
      assert.equal(command?.description, conversation.name)
    }),
)
