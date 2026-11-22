import { BrowserControl, BrowserPageRefused } from "@glass/contracts"
import { assert, it } from "@effect/vitest"
import { Effect, Fiber, Option, Stream } from "effect"
import { eventually } from "../test/eventually"
import { BrowserPages } from "./BrowserPages"

const current = <A>(stream: Stream.Stream<A>) =>
  Stream.runHead(stream).pipe(Effect.map(Option.getOrThrow))

const askedWindow = (pages: BrowserPages["Service"]) =>
  eventually(
    current(pages.requests).pipe(
      Effect.map((requests) => {
        assert.lengthOf(requests, 1)

        return requests[0]!
      }),
    ),
  )

const refuse = (pages: BrowserPages["Service"], id: string) =>
  pages.answer(id, BrowserPageRefused.make({ message: "No pane in this test." }))

it.effect(
  "refuses the agent's open and act while the user has taken over, keeps its reads, and shows each call running",
  () =>
    Effect.gen(function* () {
      const pages = yield* BrowserPages

      yield* pages.takeOver("thread")

      const opened = yield* Effect.flip(pages.open("thread", "http://localhost:3000/"))
      const acted = yield* Effect.flip(pages.act("thread", { action: "click", ref: "e2" }))

      assert.deepStrictEqual([opened._tag, acted._tag], ["BrowserTakenOver", "BrowserTakenOver"])
      assert.deepStrictEqual(yield* current(pages.requests), [])

      const reading = yield* Effect.forkChild(Effect.flip(pages.read("thread")))
      const read = yield* askedWindow(pages)

      assert.deepStrictEqual(yield* current(pages.control), [
        new BrowserControl({ threadId: "thread", agentUsing: true, userTookOver: true }),
      ])

      yield* refuse(pages, read.id)
      assert.strictEqual((yield* Fiber.join(reading)).message, "No pane in this test.")

      yield* pages.handBack("thread")
      assert.deepStrictEqual(yield* current(pages.control), [])

      const opening = yield* Effect.forkChild(Effect.flip(pages.open("thread", undefined)))
      const open = yield* askedWindow(pages)

      yield* refuse(pages, open.id)
      assert.strictEqual((yield* Fiber.join(opening)).message, "No pane in this test.")
      assert.deepStrictEqual(yield* current(pages.control), [])
    }).pipe(Effect.provide(BrowserPages.layer)),
)

it.effect("stops the agent's acting call that's still running when the user takes over", () =>
  Effect.gen(function* () {
    const pages = yield* BrowserPages

    const acting = yield* Effect.forkChild(
      Effect.flip(pages.act("thread", { action: "click", ref: "e2" })),
    )

    yield* askedWindow(pages)
    yield* pages.takeOver("thread")

    assert.strictEqual((yield* Fiber.join(acting))._tag, "BrowserTakenOver")
    assert.deepStrictEqual(yield* current(pages.control), [
      new BrowserControl({ threadId: "thread", agentUsing: false, userTookOver: true }),
    ])
  }).pipe(Effect.provide(BrowserPages.layer)),
)
