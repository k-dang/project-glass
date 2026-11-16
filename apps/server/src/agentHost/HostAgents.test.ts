import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import {
  ExtensionStatusesChanged,
  PartSet,
  TextPart,
  TurnDone,
  TurnEnded,
  TurnStarted,
} from "@glass/contracts"
import { DateTime, Deferred, Effect, Layer, Stream } from "effect"
import type { AgentAdapter } from "./adapter"
import type { StopEnding } from "./turnLoop"
import { eventually } from "../../test/eventually"
import { HostAgents, overBudget } from "./HostAgents"
import { Journal, JournalBudget } from "./Journal"
import { type HostEvent, WorkRole } from "./protocol"

const BUDGET = 1_000

const wrote = (turnId: string, chars: number) =>
  PartSet.make({ turnId, index: 0, part: TextPart.make({ text: "a".repeat(chars) }) })

it.effect("stops a Turn once the journal passes its budget, keeping everything it wrote", () =>
  Effect.gen(function* () {
    const reporting = yield* Deferred.make<(event: HostEvent) => Effect.Effect<void>>()
    const at = yield* DateTime.now
    let stops = 0

    const ended = (turnId: string) =>
      TurnEnded.make({ turnId, ended: { at, ending: TurnDone.make({}) } })

    const adapter: AgentAdapter = {
      models: Effect.die("unused"),
      commands: () => Effect.die("unused"),
      start: ({ report }) =>
        Deferred.succeed(reporting, report).pipe(
          Effect.as({
            configure: () => Effect.void,
            startTurn: () => Effect.void,
            steer: () => Effect.void,
            stopTurn: Effect.fnUntraced(function* (ending: StopEnding) {
              stops++
              yield* report(TurnEnded.make({ turnId: "turn-1", ended: { at, ending } }))

              return []
            }),
            answer: () => Effect.void,
            closed: Effect.never,
            stopped: Effect.succeed(false),
          }),
        ),
    }

    const started = (turnId: string) =>
      TurnStarted.make({ turnId, message: "", images: [], context: null, feedback: [], sentAt: at })

    yield* Effect.gen(function* () {
      const agents = yield* HostAgents
      const journal = yield* Journal

      yield* agents.start({
        agentId: "agent-1",
        engine: "pi",
        folder: ".",
        role: WorkRole.make({}),
        skills: [],
      })
      const report = yield* Deferred.await(reporting)

      yield* report(started("turn-1"))
      yield* report(wrote("turn-1", BUDGET * 2))

      const kept = yield* journal.watch(0).pipe(Stream.take(3), Stream.runCollect)

      assert.deepStrictEqual(
        kept.map(({ event }) => event),
        [
          started("turn-1"),
          wrote("turn-1", BUDGET * 2),
          TurnEnded.make({ turnId: "turn-1", ended: { at, ending: overBudget } }),
        ],
      )

      yield* journal.acknowledge(3)
      yield* report(started("turn-2"))
      yield* report(wrote("turn-2", BUDGET / 2))
      yield* report(ended("turn-2"))

      const next = yield* journal.watch(3).pipe(Stream.take(3), Stream.runCollect)

      assert.deepStrictEqual(next.at(-1)?.event, ended("turn-2"))
      assert.equal(stops, 1)
    }).pipe(
      Effect.provide(
        HostAgents.make({ "claude-code": adapter, pi: adapter }).pipe(
          Layer.provideMerge(Journal.layer),
          Layer.provide(NodeFileSystem.layer),
          Layer.provide(Layer.succeed(JournalBudget, BUDGET)),
        ),
      ),
    )
  }),
)

it.effect("keeps to the budget for a later Turn after going over it while idle", () =>
  Effect.gen(function* () {
    const reporting = yield* Deferred.make<(event: HostEvent) => Effect.Effect<void>>()
    const stoppedWhileIdle = yield* Deferred.make<void>()
    let turn: string | null = null
    let stops = 0

    const adapter: AgentAdapter = {
      models: Effect.die("unused"),
      commands: () => Effect.die("unused"),
      start: ({ report }) =>
        Deferred.succeed(reporting, report).pipe(
          Effect.as({
            configure: () => Effect.void,
            startTurn: (turnId) =>
              Effect.sync(() => {
                turn = turnId
              }),
            steer: () => Effect.void,
            stopTurn: () =>
              turn === null
                ? Deferred.succeed(stoppedWhileIdle, undefined).pipe(Effect.as(null))
                : Effect.sync(() => {
                    stops++

                    return []
                  }),
            answer: () => Effect.void,
            closed: Effect.never,
            stopped: Effect.succeed(false),
          }),
        ),
    }

    yield* Effect.gen(function* () {
      const agents = yield* HostAgents

      yield* agents.start({
        agentId: "agent-1",
        engine: "pi",
        folder: ".",
        role: WorkRole.make({}),
        skills: [],
      })
      const report = yield* Deferred.await(reporting)

      yield* report(ExtensionStatusesChanged.make({ extensionStatuses: ["a".repeat(BUDGET * 2)] }))
      yield* Deferred.await(stoppedWhileIdle)
      yield* agents.startTurn(
        "agent-1",
        "turn-1",
        { message: "Go", images: [], context: null, prompt: "Go" },
        { model: null, effort: null, permissionMode: null },
      )

      yield* eventually(
        report(wrote("turn-1", 1)).pipe(Effect.andThen(Effect.sync(() => assert.equal(stops, 1)))),
      )
    }).pipe(
      Effect.provide(
        HostAgents.make({ "claude-code": adapter, pi: adapter }).pipe(
          Layer.provideMerge(Journal.layer),
          Layer.provide(NodeFileSystem.layer),
          Layer.provide(Layer.succeed(JournalBudget, BUDGET)),
        ),
      ),
    )
  }),
)
