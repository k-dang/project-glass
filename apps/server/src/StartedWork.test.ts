import { assert, it } from "@effect/vitest"
import { localPlace, type Turn } from "@glass/contracts"
import { Effect, Predicate, Schema } from "effect"
import {
  conversationsFixture,
  glassCalls,
  globalTurns,
  lastSettled,
  conversationOutcomesInStartedWorkUpdates,
  repository,
  sendGlobal,
  settled,
} from "../test/conversationsFixture"
import { StartedItem } from "./StartedWork"

const decodeListed = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Tuple([
      Schema.Struct({
        text: Schema.fromJsonString(Schema.Struct({ items: Schema.Array(StartedItem) })),
      }),
    ]),
  ),
)

const listedBy = (turn: Turn | undefined) => {
  const [call] = glassCalls(turn) ?? []
  assert.equal(call?.status, "done", "list_started_work didn't run")

  return decodeListed(call?.output)[0].text.items
}

it.live(
  "lists the Conversations the Global conversation created or messaged, with the message that asked, after a restart",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationsFixture
      const fromUi = yield* f.start("Say hello")
      const messaged = yield* f.start("Say hi")
      yield* f.transcript(fromUi.id, settled(1))
      yield* f.transcript(messaged.id, settled(1))

      const create = `call:create_conversation ${JSON.stringify({
        repository: { owner: repository.owner, repo: repository.repo },
        baseBranch: "main",
        place: localPlace,
        harness: "pi",
        model: null,
        effort: null,
        message: "Investigate",
      })}`

      const message = `call:send_conversation_message ${JSON.stringify({ conversationId: messaged.id, message: "Again" })}`

      yield* sendGlobal(f.client, create)
      yield* sendGlobal(f.client, message)
      yield* globalTurns(f.client, settled(2))

      const created = (yield* f.conversations).find(
        ({ id }) => id !== fromUi.id && id !== messaged.id,
      )

      assert.isDefined(created)
      yield* f.transcript(created.id, settled(1))
      yield* f.transcript(messaged.id, settled(2))

      yield* globalTurns(f.client, (turns) =>
        [created.id, messaged.id].every((id) =>
          conversationOutcomesInStartedWorkUpdates(turns).some(
            ([conversationId]) => conversationId === id,
          ),
        ),
      )

      const restarted = yield* f.restart
      yield* sendGlobal(restarted, "call:list_started_work")
      const turns = yield* globalTurns(restarted, lastSettled("call:list_started_work"))

      assert.deepStrictEqual(
        listedBy(turns.at(-1)).map((item) => [
          Predicate.isTagged(item, "Conversation") && item.conversation.id,
          item.state,
          item.askedWith,
        ]),
        [
          [created.id, "finished", create],
          [messaged.id, "finished", message],
        ],
      )
    }),
)
