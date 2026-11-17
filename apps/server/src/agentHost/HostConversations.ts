import {
  type AgentCommand,
  type AgentHarness,
  type AgentModels,
  type RequestAnswer,
  RequestNotWaiting,
  TurnFailed,
  TurnStopped,
} from "@glass/contracts"
import { Context, Effect, Exit, FileSystem, Layer, Predicate, Scope, Semaphore } from "effect"
import type { HarnessAdapter, HarnessSession } from "./adapter"
import type { DeliveredMessage, DeliveredTurn } from "./deliveredMessage"
import { Journal } from "./Journal"
import { writeSentSkills } from "./sentSkills"
import {
  type RepositoryRole,
  type ConversationStart,
  type StartOutcome,
  HostConversationError,
  type HostEvent,
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
  turnId: string | null
}

export const overBudget = TurnFailed.make({
  reason:
    "The agent wrote more than its host can keep while Glass is away, so the host stopped this Turn. Everything it wrote up to here is kept.",
})

const sameSettings = (a: TurnSettings, b: TurnSettings) =>
  a.model === b.model && a.effort === b.effort && a.permissionMode === b.permissionMode

export class HostConversations extends Context.Service<
  HostConversations,
  {
    readonly models: (harness: AgentHarness) => Effect.Effect<AgentModels, HostConversationError>
    readonly commands: (
      harness: AgentHarness,
      folder: string,
      skills: ReadonlyArray<SkillSource>,
    ) => Effect.Effect<ReadonlyArray<AgentCommand>, HostConversationError>
    readonly start: (start: ConversationStart) => Effect.Effect<StartOutcome, HostConversationError>
    readonly startTurn: (
      conversationId: string,
      turnId: string,
      message: DeliveredTurn,
      settings: TurnSettings,
    ) => Effect.Effect<void, HostConversationError>
    readonly steer: (
      conversationId: string,
      message: DeliveredMessage,
    ) => Effect.Effect<void, HostConversationError>
    readonly stopTurn: (
      conversationId: string,
      turnId: string,
    ) => Effect.Effect<SteersNotTakenIn | null>
    readonly answer: (
      conversationId: string,
      requestId: string,
      answer: RequestAnswer,
    ) => Effect.Effect<void, RequestNotWaiting | HostConversationError>
    readonly stop: (conversationId: string) => Effect.Effect<void>
  }
>()("@glass/server/agentHost/HostConversations") {
  static readonly make = (adapters: Harnesses) =>
    Layer.effect(
      HostConversations,
      Effect.gen(function* () {
        const journal = yield* Journal
        const fs = yield* FileSystem.FileSystem

        const written = (folder: string, skills: ReadonlyArray<SkillSource>) =>
          writeSentSkills(folder, skills).pipe(Effect.provideService(FileSystem.FileSystem, fs))

        const hostScope = yield* Scope.Scope
        const running = new Map<string, Running>()
        const locks = new Map<string, { semaphore: Semaphore.Semaphore; holders: number }>()

        const withConversation = <A, E, R>(
          conversationId: string,
          effect: Effect.Effect<A, E, R>,
        ) =>
          Effect.suspend(() => {
            const lock = locks.get(conversationId) ?? {
              semaphore: Semaphore.makeUnsafe(1),
              holders: 0,
            }

            lock.holders += 1
            locks.set(conversationId, lock)

            return lock.semaphore
              .withPermits(1)(effect)
              .pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    lock.holders -= 1

                    if (lock.holders === 0 && locks.get(conversationId) === lock)
                      locks.delete(conversationId)
                  }),
                ),
              )
          })

        const retire = (conversationId: string, conversation: Running | undefined) =>
          Effect.suspend(() => {
            if (conversation === undefined) return Effect.void

            if (running.get(conversationId) === conversation) running.delete(conversationId)

            return Scope.close(conversation.scope, Exit.void)
          })

        const start = Effect.fn("HostConversations.start")(
          function* (starting: ConversationStart) {
            const { conversationId, folder } = starting
            const current = running.get(conversationId)

            if (current !== undefined) {
              if (!(yield* current.session.stopped)) return "alreadyRunning" as const

              yield* retire(conversationId, current)
            }

            const scope = yield* Scope.fork(hostScope)
            let stoppingOverBudget = false

            let leftOverBudget: SteersNotTakenIn = []

            const report = Effect.fnUntraced(function* (event: HostEvent) {
              const full = yield* journal.append(
                conversationId,
                Predicate.isTagged(event, "TurnEnded") && leftOverBudget.length > 0
                  ? { ...event, steersNotTakenIn: leftOverBudget }
                  : event,
              )

              const conversation = running.get(conversationId)

              if (
                Predicate.isTagged(event, "TurnStarted") ||
                Predicate.isTagged(event, "TurnEnded")
              ) {
                if (conversation !== undefined)
                  conversation.turnId = Predicate.isTagged(event, "TurnStarted")
                    ? event.turnId
                    : null
                stoppingOverBudget = false
                leftOverBudget = []

                return
              }

              if (!full || stoppingOverBudget || conversation?.turnId == null) return

              stoppingOverBudget = true
              const steers = yield* conversation.session.stopTurn(conversation.turnId, overBudget)

              if (steers === null) stoppingOverBudget = false
              else if (stoppingOverBudget) leftOverBudget = steers
            })

            const started = Effect.gen(function* () {
              const skills = yield* written(folder, starting.skills)

              return yield* starting.harness === "pi"
                ? adapters.pi.start({
                    folder,
                    conversation: conversationId,
                    role: starting.role,
                    skills,
                    report,
                  })
                : adapters["claude-code"].start({
                    folder,
                    conversation: conversationId,
                    role: starting.role,
                    skills,
                    report,
                  })
            })

            const session = yield* started.pipe(
              Scope.provide(scope),
              Effect.onError(() => Scope.close(scope, Exit.void)),
            )

            const conversation: Running = {
              scope,
              session,
              applied: { model: null, effort: null, permissionMode: null },
              turnId: null,
            }

            running.set(conversationId, conversation)

            yield* session.closed.pipe(
              Effect.andThen(
                withConversation(conversationId, retire(conversationId, conversation)),
              ),
              Effect.forkIn(scope),
            )

            return "started" as const
          },
          (effect, starting) => withConversation(starting.conversationId, effect),
        )

        const find = (conversationId: string) =>
          Effect.suspend(() => {
            const conversation = running.get(conversationId)

            return conversation === undefined
              ? Effect.fail(
                  new HostConversationError({
                    message: "The Conversation's harness isn't running.",
                  }),
                )
              : Effect.succeed(conversation)
          })

        const conversations = HostConversations.of({
          models: (harness) => adapters[harness].models,
          commands: (harness, folder, skills) =>
            written(folder, skills).pipe(
              Effect.flatMap((paths) => adapters[harness].commands(folder, paths)),
              Effect.scoped,
            ),
          start,
          startTurn: Effect.fnUntraced(function* (conversationId, turnId, message, settings) {
            const conversation = yield* find(conversationId)

            if (!sameSettings(conversation.applied, settings)) {
              yield* conversation.session.configure(settings)
              conversation.applied = settings
            }

            conversation.turnId = turnId

            return yield* conversation.session.startTurn(turnId, message)
          }),
          steer: (conversationId, message) =>
            find(conversationId).pipe(Effect.flatMap(({ session }) => session.steer(message))),
          stopTurn: (conversationId, turnId) =>
            Effect.suspend(
              () =>
                running.get(conversationId)?.session.stopTurn(turnId, TurnStopped.make({})) ??
                Effect.succeed(null),
            ),
          answer: (conversationId, requestId, answer) =>
            Effect.suspend(() => {
              const conversation = running.get(conversationId)

              return conversation === undefined
                ? Effect.fail(new RequestNotWaiting())
                : conversation.session.answer(requestId, answer)
            }),
          stop: (conversationId) =>
            withConversation(
              conversationId,
              Effect.suspend(() => retire(conversationId, running.get(conversationId))),
            ),
        })

        coordination.set(conversations, locks)

        return conversations
      }),
    )
}

interface ConversationLockOwner {
  readonly stop: (conversationId: string) => Effect.Effect<void>
}

const coordination = new WeakMap<
  ConversationLockOwner,
  Map<string, { semaphore: Semaphore.Semaphore; holders: number }>
>()

export const conversationLock = (
  owner: ConversationLockOwner,
  conversationId: string,
): object | undefined => coordination.get(owner)?.get(conversationId)
