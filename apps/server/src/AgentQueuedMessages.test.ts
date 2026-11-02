import { assert, it } from "@effect/vitest"
import {
  type Transcript,
  type Turn,
  TurnDone,
  TurnInterrupted,
  TurnStopped,
} from "@glass/contracts"
import { Effect, Predicate } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { agentsFixture, claudeCode, pixel, settled } from "../test/agentsFixture"
import { vi } from "vite-plus/test"

vi.stubEnv("PI_OFFLINE", "1")

const queuedMessages = ({ queued }: Transcript) => queued.map(({ message }) => message)

const endings = (turns: ReadonlyArray<Turn>) =>
  turns.map(({ message, ended }) => ({ message, ending: ended?.ending._tag }))

const holding = { output: "Done.", hang: true }

for (const engine of ["pi", "claude-code"] as const)
  it.live(
    `queues messages sent while a ${engine} Turn runs, starting them in order as Turns end, except a cancelled one`,
    () =>
      Effect.gen(function* () {
        const f = yield* agentsFixture(holding, undefined, { hang: true })
        const agent = yield* f.start("First", { engine, model: null, effort: null })
        yield* f.transcript(agent.id, (turns) => turns.length === 1)

        for (const message of ["Second", "Third", "Fourth"]) yield* f.send(agent.id, message)

        const waiting = yield* f.watch(agent.id, ({ queued }) => queued.length === 3)
        assert.deepStrictEqual(queuedMessages(waiting), ["Second", "Third", "Fourth"])

        const third = waiting.queued[1]?.id ?? ""
        yield* f.client.CancelQueuedMessage({ agentId: agent.id, queuedMessageId: third })
        yield* f.watch(agent.id, ({ queued }) => queued.length === 2)

        yield* f.model.release({ output: "Done." })
        yield* f.claude.configure({})

        const done = yield* f.watch(agent.id, ({ turns }) => settled(3)(turns))
        assert.deepStrictEqual(endings(done.turns), [
          { message: "First", ending: "Done" },
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
      const f = yield* agentsFixture(holding)
      const agent = yield* f.start()
      yield* f.model.received(1)
      yield* f.send(agent.id, "Again")

      const restarted = yield* f.restart
      yield* f.model.release({ output: "Done." })

      const interrupted = yield* f.watch(agent.id, ({ turns }) => settled(1)(turns), restarted)
      assert.deepStrictEqual(interrupted.turns[0]?.ended?.ending, TurnInterrupted.make({}))
      assert.deepStrictEqual(queuedMessages(interrupted), ["Again"])

      const [again] = interrupted.queued
      yield* restarted.SendQueuedMessage({ agentId: agent.id, queuedMessageId: again?.id ?? "" })

      const sent = yield* f.watch(agent.id, ({ turns }) => settled(2)(turns), restarted)
      assert.deepStrictEqual(endings(sent.turns), [
        { message: "Say hello", ending: "Interrupted" },
        { message: "Again", ending: "Done" },
      ])
      assert.deepStrictEqual(sent.queued, [])
    }),
)

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

it.live("Steers a Claude Code Turn, which takes the message in before it ends", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({}, undefined, { hang: true })
    const agent = yield* f.start("Start", claudeCode)
    yield* f.transcript(agent.id, (turns) => turns.length === 1)
    yield* f.claude.logged("prompt", 1)

    yield* f.steer(agent.id, "Change course")

    const done = yield* f.watch(agent.id, ({ turns }) => settled(1)(turns))
    assert.deepStrictEqual(done.turns[0]?.ended?.ending, TurnDone.make({}))
    assert.deepStrictEqual(shownParts(done.turns[0]), [
      { steer: "Change course" },
      { text: "Taken in: Change course" },
    ])
    assert.deepStrictEqual(done.queued, [])
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

it.live("stops a Claude Code Turn, keeping its Queued messages", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({}, undefined, { hang: true })
    const agent = yield* f.start("Start", claudeCode)
    yield* f.claude.logged("prompt", 1)

    yield* f.send(agent.id, "Later")
    yield* f.client.StopTurn({ agentId: agent.id })

    const stopped = yield* f.watch(agent.id, ({ turns }) => settled(1)(turns))
    assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))
    assert.deepStrictEqual(queuedMessages(stopped), ["Later"])
  }),
)

it.live("stops a Turn whose program is still starting, which never gets the message", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({}, undefined, { holdStart: true })
    const agent = yield* f.start("Start", claudeCode)
    yield* f.claude.logged("control", 1)

    yield* f.client.StopTurn({ agentId: agent.id })
    const [stopped] = yield* f.transcript(agent.id, settled(1))
    assert.deepStrictEqual(stopped?.ended?.ending, TurnStopped.make({}))

    yield* f.claude.configure({})
    yield* f.send(agent.id, "Next")
    yield* f.transcript(agent.id, settled(2))

    const prompts = (yield* f.claude.log).flatMap((entry) =>
      entry.kind === "prompt" ? [entry.prompt] : [],
    )

    assert.deepStrictEqual(prompts, ["Next"])
  }),
)
