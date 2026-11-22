import { assert, it } from "@effect/vitest"
import {
  type ThreadPlace,
  localPlace,
  SandboxPlace,
  TextPart,
  TurnCutOff,
  TurnDone,
} from "@glass/contracts"
import { Effect, Predicate } from "effect"
import { TestClock } from "effect/testing"
import { withSkippableWaits } from "../test/deadlines"
import {
  glassCall,
  threadOutcomesInStartedWorkUpdates,
  threadsFixture,
  glassCalls,
  holding,
  lastText,
  repository,
  settled,
} from "../test/threadsFixture"
import { FIRST_LOST_RETRY_SPACING, QUICK_RETRY_SPACING } from "./reconnecting"

const createIn = (place: ThreadPlace, message: string) =>
  glassCall("create_thread", {
    repository: { owner: repository.owner, repo: repository.repo },
    baseBranch: "main",
    place,
    harness: "pi",
    model: null,
    effort: null,
    message,
  })

it.live("a Thread in a Sandbox creates a Thread through Glass's tools and hears when it ends", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture

    const parent = yield* f.startSandbox(
      createIn(SandboxPlace.make({ providerId: "fake" }), "hold:child"),
    )

    yield* f.transcript(parent.id, settled(1))
    const [child] = (yield* f.threads).filter(({ id }) => id !== parent.id)
    yield* f.transcript(child!.id, holding)
    yield* f.release("child")

    const turns = yield* f.transcript(parent.id, settled(2))

    assert.deepStrictEqual(child?.place, SandboxPlace.make({ providerId: "fake" }))
    assert.deepStrictEqual(threadOutcomesInStartedWorkUpdates(turns), [[child!.id, "finished"]])
  }),
)

it.live("a Thread in a Sandbox can't create or message one on this device", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    const local = yield* f.start("Say hello")
    yield* f.transcript(local.id, settled(1))

    const sandboxed = yield* f.startSandbox(createIn(localPlace, "Investigate"))
    yield* f.transcript(sandboxed.id, settled(1))
    yield* f.send(
      sandboxed.id,
      glassCall("send_thread_message", { threadId: local.id, message: "Hi" }),
    )
    const [created, messaged] = yield* f.transcript(sandboxed.id, settled(2))

    assert.deepStrictEqual(
      [...(glassCalls(created) ?? []), ...(glassCalls(messaged) ?? [])].map(({ status }) => status),
      ["failed", "failed"],
    )
    assert.include(
      glassCalls(created)?.[0]?.output,
      "A Thread in a Sandbox can only create Threads in a Sandbox.",
    )
    assert.include(
      glassCalls(messaged)?.[0]?.output,
      "A Thread in a Sandbox can only message Threads in a Sandbox.",
    )
    assert.deepStrictEqual(
      (yield* f.threads).map(({ id }) => id),
      [sandboxed.id, local.id],
    )
  }),
)

it.effect("cuts off only the running Turn of a Thread whose Sandbox host is lost", () =>
  withSkippableWaits(QUICK_RETRY_SPACING, (skipQuickRetries) =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const local = yield* f.start("hold:local")
      const sandboxed = yield* f.startSandbox("hold:sandboxed")
      yield* f.transcript(local.id, holding)
      yield* f.transcript(sandboxed.id, holding)

      yield* Effect.promise(() => f.sandboxes.killHost(sandboxed.id))
      yield* skipQuickRetries

      const [lost] = yield* f.transcript(sandboxed.id, settled(1))
      assert.deepStrictEqual(lost?.ended?.ending, TurnCutOff.make({}))

      yield* f.release("local")
      const [kept] = yield* f.transcript(local.id, settled(1))
      assert.deepStrictEqual(kept?.ended?.ending, TurnDone.make({}))
    }),
  ),
)

it.live("fills in what a Sandbox Thread did while Glass was closed, once Glass opens again", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    const thread = yield* f.startSandbox("hold:start")
    yield* f.transcript(thread.id, holding)

    yield* f.quit
    yield* f.release("start")
    const relaunched = yield* f.launch

    const [turn] = yield* f.transcript(thread.id, settled(1), relaunched)
    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepStrictEqual(
      turn?.parts.filter((part) => Predicate.isTagged(part, "Text")),
      [TextPart.make({ text: "Holding." }), TextPart.make({ text: "Reply to: hold:start" })],
    )
  }),
)

it.effect(
  "marks a Sandbox it can't reach unreachable without holding up local Threads, then fills in how its Turn ended",
  () =>
    withSkippableWaits(QUICK_RETRY_SPACING, (skipQuickRetries) =>
      Effect.gen(function* () {
        const f = yield* threadsFixture
        const local = yield* f.start("hold:local")
        const sandboxed = yield* f.startSandbox("hold:sandboxed")
        yield* f.transcript(local.id, holding)
        yield* f.transcript(sandboxed.id, holding)

        yield* Effect.promise(() => f.sandboxes.dropConnections(sandboxed.id))
        yield* skipQuickRetries
        yield* f.sandboxStatus(sandboxed.id, ({ reach }) => reach === "unreachable")
        const [cutOff] = yield* f.transcript(sandboxed.id, settled(1))
        assert.deepStrictEqual(cutOff?.ended?.ending, TurnCutOff.make({}))

        yield* f.release("local")
        yield* f.release("sandboxed")
        const [kept] = yield* f.transcript(local.id, settled(1))
        assert.deepStrictEqual(kept?.ended?.ending, TurnDone.make({}))

        f.sandboxes.reconnect(sandboxed.id)
        yield* TestClock.adjust(FIRST_LOST_RETRY_SPACING)
        yield* f.sandboxStatus(sandboxed.id, ({ reach }) => reach === "reachable")

        const [filledIn] = yield* f.transcript(
          sandboxed.id,
          ([turn]) => turn?.ended?.ending._tag === "Done",
        )

        assert.deepStrictEqual(
          lastText(filledIn),
          TextPart.make({ text: "Reply to: hold:sandboxed" }),
        )
      }),
    ),
)

it.effect("cuts off a Turn whose Sandbox host died while Glass was closed", () =>
  withSkippableWaits(QUICK_RETRY_SPACING, (skipQuickRetries) =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const thread = yield* f.startSandbox("hold:start")
      yield* f.transcript(thread.id, holding)

      yield* f.quit
      yield* Effect.promise(() => f.sandboxes.killHost(thread.id))
      yield* skipQuickRetries
      const relaunched = yield* f.launch

      yield* f.sandboxStatus(thread.id, ({ reach }) => reach === "unreachable", relaunched)
      const [turn] = yield* f.transcript(thread.id, settled(1), relaunched)
      assert.deepStrictEqual(turn?.ended?.ending, TurnCutOff.make({}))
    }),
  ),
)
