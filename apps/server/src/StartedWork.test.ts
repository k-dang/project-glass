import { assert, it } from "@effect/vitest"
import { localPlace, type Turn } from "@glass/contracts"
import { Effect, Predicate, Schema } from "effect"
import {
  agentsFixture,
  glassCalls,
  globalTurns,
  repository,
  sendGlobal,
  settled,
} from "../test/agentsFixture"
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
  "lists the Agents the Global conversation created or messaged, with the message that asked, after a restart",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const fromUi = yield* f.start("Say hello")
      const messaged = yield* f.start("Say hi")
      yield* f.transcript(fromUi.id, settled(1))
      yield* f.transcript(messaged.id, settled(1))

      const create = `call:create_agent ${JSON.stringify({
        repository: { owner: repository.owner, repo: repository.repo },
        baseBranch: "main",
        place: localPlace,
        engine: "pi",
        model: null,
        effort: null,
        message: "Investigate",
      })}`

      const message = `call:send_agent_message ${JSON.stringify({ agentId: messaged.id, message: "Again" })}`

      yield* sendGlobal(f.client, create)
      yield* sendGlobal(f.client, message)
      yield* globalTurns(f.client, settled(2))
      const created = (yield* f.agents).find(({ id }) => id !== fromUi.id && id !== messaged.id)
      assert.isDefined(created)
      yield* f.transcript(created.id, settled(1))
      yield* f.transcript(messaged.id, settled(2))

      const restarted = yield* f.restart
      yield* sendGlobal(restarted, "call:list_started_work")
      const turns = yield* globalTurns(restarted, settled(3))

      assert.deepStrictEqual(
        listedBy(turns[2]).map((item) => [
          Predicate.isTagged(item, "Agent") && item.agent.id,
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
