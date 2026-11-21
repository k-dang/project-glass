import {
  type AgentCommand,
  type AgentHarness,
  type AgentModels,
  type RequestAnswer,
  RequestNotWaiting,
  TurnFailed,
  TurnStopped,
} from "@glass/contracts"
import {
  Context,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Match,
  Predicate,
  Scope,
  SubscriptionRef,
} from "effect"
import type { HarnessAdapter, HarnessSession } from "./adapter"
import type { DeliveredMessage, DeliveredTurn } from "./deliveredMessage"
import { HostGlassTools } from "./HostGlassTools"
import { keyedLock } from "../keyedLock"
import { Journal } from "./Journal"
import { writeSentSkills } from "./sentSkills"
import {
  type RepositoryRole,
  type ThreadStart,
  type StartOutcome,
  HostThreadError,
  type HostEvent,
  type UnacknowledgedTurn,
  type SkillSource,
  type SteersNotTakenIn,
  type TurnSettings,
} from "./protocol"

export interface Harnesses {
  readonly "claude-code": HarnessAdapter<RepositoryRole>
  readonly pi: HarnessAdapter
}

interface Running {
  readonly scope: Scope.Closeable
  readonly session: HarnessSession
  applied: TurnSettings
}

interface OverBudgetStop {
  readonly turnId: string
  readonly steers: Deferred.Deferred<SteersNotTakenIn | null>
}

export const overBudget = TurnFailed.make({
  reason:
    "The agent wrote more than its host can keep while Glass is away, so the host stopped this Turn. Everything it wrote up to here is kept.",
})

const sameSettings = (a: TurnSettings, b: TurnSettings) =>
  a.model === b.model && a.effort === b.effort && a.permissionMode === b.permissionMode

export class HostThreads extends Context.Service<
  HostThreads,
  {
    readonly models: (harness: AgentHarness) => Effect.Effect<AgentModels, HostThreadError>
    readonly commands: (
      harness: AgentHarness,
      folder: string,
      skills: ReadonlyArray<SkillSource>,
    ) => Effect.Effect<ReadonlyArray<AgentCommand>, HostThreadError>
    readonly start: (start: ThreadStart) => Effect.Effect<StartOutcome, HostThreadError>
    readonly startTurn: (
      threadId: string,
      turnId: string,
      message: DeliveredTurn,
      settings: TurnSettings,
    ) => Effect.Effect<void, HostThreadError>
    readonly steer: (
      threadId: string,
      message: DeliveredMessage,
    ) => Effect.Effect<void, HostThreadError>
    readonly stopTurn: (threadId: string, turnId: string) => Effect.Effect<SteersNotTakenIn | null>
    readonly answer: (
      threadId: string,
      requestId: string,
      answer: RequestAnswer,
    ) => Effect.Effect<void, RequestNotWaiting | HostThreadError>
    readonly stop: (threadId: string) => Effect.Effect<void>
    readonly runningTurns: SubscriptionRef.SubscriptionRef<ReadonlyMap<string, string>>
    readonly unacknowledgedTurns: Effect.Effect<ReadonlyArray<UnacknowledgedTurn>>
  }
>()("@glass/server/agentHost/HostThreads") {
  static readonly make = (adapters: Harnesses) =>
    Layer.effect(
      HostThreads,
      Effect.gen(function* () {
        const journal = yield* Journal
        const glassTools = yield* HostGlassTools
        const fs = yield* FileSystem.FileSystem

        const written = (folder: string, skills: ReadonlyArray<SkillSource>) =>
          writeSentSkills(folder, skills).pipe(Effect.provideService(FileSystem.FileSystem, fs))

        const hostScope = yield* Scope.Scope
        const running = new Map<string, Running>()
        const runningTurns = yield* SubscriptionRef.make<ReadonlyMap<string, string>>(new Map())

        const setTurn = (threadId: string, turnId: string | null) =>
          SubscriptionRef.update(runningTurns, (turns) => {
            const next = new Map(turns)

            if (turnId === null) next.delete(threadId)
            else next.set(threadId, turnId)

            return next
          })

        const withThread = keyedLock().withLock

        const retire = (threadId: string, thread: Running | undefined) =>
          Effect.suspend(() => {
            if (thread === undefined) return Effect.void

            if (running.get(threadId) !== thread) return Scope.close(thread.scope, Exit.void)

            running.delete(threadId)

            return Scope.close(thread.scope, Exit.void).pipe(
              Effect.andThen(setTurn(threadId, null)),
            )
          })

        const start = Effect.fn("HostThreads.start")(
          function* (starting: ThreadStart) {
            const { threadId, folder } = starting
            const current = running.get(threadId)

            if (current !== undefined) {
              if (!(yield* current.session.stopped)) return "alreadyRunning" as const

              yield* retire(threadId, current)
            }

            const scope = yield* Scope.fork(hostScope)
            let overBudgetStop: OverBudgetStop | null = null

            const withSteersNotTakenIn = Effect.fnUntraced(function* (event: HostEvent) {
              const stop = overBudgetStop

              if (!Predicate.isTagged(event, "TurnEnded") || stop?.turnId !== event.turnId)
                return event

              const steers = yield* Deferred.await(stop.steers)

              return steers === null || steers.length === 0
                ? event
                : { ...event, steersNotTakenIn: steers }
            })

            const report = Effect.fnUntraced(function* (event: HostEvent) {
              const full = yield* journal.append(threadId, yield* withSteersNotTakenIn(event))
              const thread = running.get(threadId)

              if (
                Predicate.isTagged(event, "TurnStarted") ||
                Predicate.isTagged(event, "TurnEnded")
              ) {
                overBudgetStop = null

                if (thread !== undefined)
                  yield* setTurn(
                    threadId,
                    Predicate.isTagged(event, "TurnStarted") ? event.turnId : null,
                  )

                return
              }

              const turnId = (yield* SubscriptionRef.get(runningTurns)).get(threadId)

              if (!full || overBudgetStop !== null || thread === undefined || turnId === undefined)
                return

              const stop: OverBudgetStop = {
                turnId,
                steers: yield* Deferred.make<SteersNotTakenIn | null>(),
              }

              overBudgetStop = stop
              yield* thread.session.stopTurn(stop.turnId, overBudget).pipe(
                Effect.tap((steers) =>
                  Effect.sync(() => {
                    if (steers === null && overBudgetStop === stop) overBudgetStop = null
                  }),
                ),
                Effect.onExit((exit) => Deferred.done(stop.steers, exit)),
                Effect.forkIn(scope),
              )
            })

            const started = Effect.gen(function* () {
              const skills = yield* written(folder, starting.skills)

              const tools = yield* Match.value(starting.role).pipe(
                Match.tagsExhaustive({
                  Global: (role) => Effect.succeed(role.tools),
                  Work: () => glassTools.access(threadId),
                  Review: () => Effect.succeed(undefined),
                }),
              )

              return yield* starting.harness === "pi"
                ? adapters.pi.start({
                    folder,
                    thread: threadId,
                    role: starting.role,
                    glassTools: tools,
                    skills,
                    report,
                  })
                : adapters["claude-code"].start({
                    folder,
                    thread: threadId,
                    role: starting.role,
                    glassTools: tools,
                    skills,
                    report,
                  })
            })

            const session = yield* started.pipe(
              Scope.provide(scope),
              Effect.onError(() => Scope.close(scope, Exit.void)),
            )

            const thread: Running = {
              scope,
              session,
              applied: { model: null, effort: null, permissionMode: null },
            }

            running.set(threadId, thread)

            yield* session.closed.pipe(
              Effect.andThen(withThread(threadId, retire(threadId, thread))),
              Effect.forkIn(scope),
            )

            return "started" as const
          },
          (effect, starting) => withThread(starting.threadId, effect),
        )

        const find = (threadId: string) =>
          Effect.suspend(() => {
            const thread = running.get(threadId)

            return thread === undefined
              ? Effect.fail(
                  new HostThreadError({
                    message: "The Thread's harness isn't running.",
                  }),
                )
              : Effect.succeed(thread)
          })

        const threads = HostThreads.of({
          models: (harness) => adapters[harness].models,
          commands: (harness, folder, skills) =>
            written(folder, skills).pipe(
              Effect.flatMap((paths) => adapters[harness].commands(folder, paths)),
              Effect.scoped,
            ),
          start,
          startTurn: Effect.fnUntraced(function* (threadId, turnId, message, settings) {
            const thread = yield* find(threadId)

            if (!sameSettings(thread.applied, settings)) {
              yield* thread.session.configure(settings)
              thread.applied = settings
            }

            yield* setTurn(threadId, turnId)

            return yield* thread.session.startTurn(turnId, message)
          }),
          steer: (threadId, message) =>
            find(threadId).pipe(Effect.flatMap(({ session }) => session.steer(message))),
          stopTurn: (threadId, turnId) =>
            Effect.suspend(
              () =>
                running.get(threadId)?.session.stopTurn(turnId, TurnStopped.make({})) ??
                Effect.succeed(null),
            ),
          answer: (threadId, requestId, answer) =>
            Effect.suspend(() => {
              const thread = running.get(threadId)

              return thread === undefined
                ? Effect.fail(new RequestNotWaiting())
                : thread.session.answer(requestId, answer)
            }),
          stop: (threadId) =>
            withThread(
              threadId,
              Effect.suspend(() => retire(threadId, running.get(threadId))),
            ),
          runningTurns,
          unacknowledgedTurns: Effect.all([
            SubscriptionRef.get(runningTurns),
            journal.unacknowledgedEnds,
          ]).pipe(
            Effect.map(([turns, ended]) => [
              ...Array.from(turns, ([threadId, turnId]) => ({ threadId, turnId })),
              ...ended,
            ]),
          ),
        })

        return threads
      }),
    )
}
