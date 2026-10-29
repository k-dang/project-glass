import {
  type AgentEngine,
  type AgentModels,
  type RequestAnswer,
  RequestNotWaiting,
  type SentMessage,
} from "@glass/contracts"
import { Context, Effect, Exit, Layer, Scope, Semaphore } from "effect"
import type { AgentAdapter, AgentSession } from "./adapter"
import { Journal } from "./Journal"
import { HostAgentError, type TurnSettings } from "./protocol"

interface Running {
  readonly scope: Scope.Closeable
  readonly session: AgentSession
  applied: TurnSettings
}

const sameSettings = (a: TurnSettings, b: TurnSettings) =>
  a.model === b.model && a.effort === b.effort && a.permissionMode === b.permissionMode

export class HostAgents extends Context.Service<
  HostAgents,
  {
    readonly models: (engine: AgentEngine) => Effect.Effect<AgentModels, HostAgentError>
    readonly start: (
      agentId: string,
      engine: AgentEngine,
      folder: string,
    ) => Effect.Effect<void, HostAgentError>
    readonly startTurn: (
      agentId: string,
      turnId: string,
      message: SentMessage,
      settings: TurnSettings,
    ) => Effect.Effect<void, HostAgentError>
    readonly steer: (agentId: string, message: SentMessage) => Effect.Effect<void, HostAgentError>
    readonly stopTurn: (agentId: string) => Effect.Effect<ReadonlyArray<SentMessage> | null>
    readonly answer: (
      agentId: string,
      requestId: string,
      answer: RequestAnswer,
    ) => Effect.Effect<void, RequestNotWaiting | HostAgentError>
    readonly stop: (agentId: string) => Effect.Effect<void>
  }
>()("@glass/server/agentHost/HostAgents") {
  static readonly make = (adapters: Record<AgentEngine, AgentAdapter>) =>
    Layer.effect(
      HostAgents,
      Effect.gen(function* () {
        const journal = yield* Journal
        const hostScope = yield* Scope.Scope
        const running = new Map<string, Running>()
        const lock = yield* Semaphore.make(1)

        const start = Effect.fn("HostAgents.start")(
          function* (agentId: string, engine: AgentEngine, folder: string) {
            const current = running.get(agentId)

            if (current !== undefined && !(yield* current.session.stopped)) return

            const scope = yield* Scope.fork(hostScope)

            const session = yield* adapters[engine]
              .start({
                folder,
                conversation: agentId,
                report: (event) => journal.append(agentId, event),
              })
              .pipe(
                Scope.provide(scope),
                Effect.onError(() => Scope.close(scope, Exit.void)),
              )

            const agent: Running = {
              scope,
              session,
              applied: { model: null, effort: null, permissionMode: null },
            }

            running.set(agentId, agent)

            yield* session.closed.pipe(
              Effect.andThen(
                lock.withPermits(1)(
                  Effect.sync(() => {
                    if (running.get(agentId) === agent) running.delete(agentId)
                  }),
                ),
              ),
              Effect.andThen(Scope.close(scope, Exit.void)),
              Effect.forkIn(scope),
            )
          },
          (effect) => lock.withPermits(1)(effect),
        )

        const find = (agentId: string) =>
          Effect.suspend(() => {
            const agent = running.get(agentId)

            return agent === undefined
              ? Effect.fail(new HostAgentError({ message: "The Agent's program isn't running." }))
              : Effect.succeed(agent)
          })

        return HostAgents.of({
          models: (engine) => adapters[engine].models,
          start,
          startTurn: Effect.fnUntraced(function* (agentId, turnId, message, settings) {
            const agent = yield* find(agentId)

            if (!sameSettings(agent.applied, settings)) {
              yield* agent.session.configure(settings)
              agent.applied = settings
            }

            return yield* agent.session.startTurn(turnId, message)
          }),
          steer: (agentId, message) =>
            find(agentId).pipe(Effect.flatMap(({ session }) => session.steer(message))),
          stopTurn: (agentId) =>
            Effect.suspend(() => running.get(agentId)?.session.stopTurn ?? Effect.succeed(null)),
          answer: (agentId, requestId, answer) =>
            Effect.suspend(() => {
              const agent = running.get(agentId)

              // A stopped program's requests ended with its Turn.
              return agent === undefined
                ? Effect.fail(new RequestNotWaiting())
                : agent.session.answer(requestId, answer)
            }),
          stop: Effect.fnUntraced(function* (agentId: string) {
            const agent = yield* lock.withPermits(1)(
              Effect.sync(() => {
                const stopping = running.get(agentId)
                running.delete(agentId)

                return stopping
              }),
            )

            if (agent !== undefined) yield* Scope.close(agent.scope, Exit.void)
          }),
        })
      }),
    )
}
