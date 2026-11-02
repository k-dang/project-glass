import { assert, it } from "@effect/vitest"
import { type Transcript, type Turn, TurnDone, TurnStopped } from "@glass/contracts"
import { Effect, Predicate } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { agentsFixture, pixel, settled } from "../test/agentsFixture"
import { vi } from "vite-plus/test"

vi.stubEnv("PI_OFFLINE", "1")

const queuedMessages = ({ queued }: Transcript) => queued.map(({ message }) => message)

const holding = { output: "Done.", hang: true }

const shownParts = (turn: Turn | undefined) =>
  turn?.parts.map((part) =>
    Predicate.isTagged(part, "Steer")
      ? { steer: part.message }
      : Predicate.isTagged(part, "Text")
        ? { text: part.text }
        : part._tag,
  )

it.live("Steers a pi Turn, which takes the message in before it ends", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture(holding)
    const agent = yield* f.start("Start")
    yield* f.model.received(1)

    yield* f.steer(agent.id, "Change course")
    yield* f.model.release({
      output: ({ messages }) =>
        JSON.stringify(messages).includes("Change course") ? "Changed." : "Started.",
    })

    const [turn] = yield* f.transcript(agent.id, settled(1))
    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepStrictEqual(shownParts(turn), [
      { text: "Started." },
      { steer: "Change course" },
      { text: "Changed." },
    ])
  }),
)

it.live(
  "stops a pi Turn, keeping Queued messages and putting back a Steer pi hadn't taken in",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture(holding)
      const agent = yield* f.start()
      yield* f.model.received(1)

      yield* f.send(agent.id, "Later")
      yield* f.steer(agent.id, "Now, please")
      yield* f.client.StopTurn({ agentId: agent.id })

      const stopped = yield* f.watch(agent.id, ({ turns }) => settled(1)(turns))
      assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))
      assert.deepStrictEqual(shownParts(stopped.turns[0]), [])
      assert.deepStrictEqual(queuedMessages(stopped), ["Now, please", "Later"])
      yield* f.model.cancelled(1)
    }),
)

const inputExtension = (home: string) =>
  Effect.promise(async () => {
    const extensions = join(home, ".pi", "agent", "extensions")
    await mkdir(extensions, { recursive: true })
    await writeFile(
      join(extensions, "input.js"),
      `export default (pi) => pi.on("input", async (event) => {
        if (event.text === "ping") return { action: "handled" }
        if (event.text === "remind me") {
          pi.sendUserMessage("Check the tests", { deliverAs: "followUp" })
          return { action: "handled" }
        }
        if (event.text.startsWith("?quick ")) return { action: "transform", text: "Briefly: " + event.text.slice(7) }
        return { action: "continue" }
      })`,
    )
  })

it.live("shows a Steer a pi extension handles itself, without Queueing it", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture(holding)
    yield* inputExtension(f.home)
    const agent = yield* f.start()
    yield* f.model.received(1)

    yield* f.steer(agent.id, "ping")
    yield* f.model.release({ output: "Done." })

    const done = yield* f.watch(agent.id, ({ turns }) => settled(1)(turns))
    assert.deepStrictEqual(shownParts(done.turns[0]), [{ steer: "ping" }, { text: "Done." }])
    assert.deepStrictEqual(done.queued, [])
    assert.lengthOf(f.model.calls, 1)
  }),
)

it.live(
  "puts back what pi held when the Turn stops: Steers as the user wrote them, then pi's own",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture(holding)
      yield* inputExtension(f.home)
      const agent = yield* f.start()
      yield* f.model.received(1)

      yield* f.steer(agent.id, "?quick tabs or spaces?", [pixel])
      yield* f.steer(agent.id, "remind me")
      yield* f.client.StopTurn({ agentId: agent.id })

      const stopped = yield* f.watch(agent.id, ({ turns }) => settled(1)(turns))
      assert.deepStrictEqual(
        stopped.queued.map(({ message, images }) => ({ message, images })),
        [
          { message: "?quick tabs or spaces?", images: [pixel] },
          { message: "Check the tests", images: [] },
        ],
      )
    }),
)
