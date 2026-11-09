import {
  type AgentCommand,
  type AgentEngine,
  type AgentEvent,
  type AgentModels,
  type RequestAnswer,
  RequestNotWaiting,
} from "@glass/contracts"
import { Context, Effect, Exit, FileSystem, Layer, Predicate, Scope, Semaphore } from "effect"
import type { AgentAdapter, AgentSession } from "./adapter"
import type { DeliveredMessage } from "./deliveredMessage"
import { Journal } from "./Journal"
import { writeSentSkills } from "./sentSkills"
import {
  type AgentRole,
  type ConversationStart,
  HostAgentError,
  type SkillSource,
  type SteersNotTakenIn,
  type TurnSettings,
} from "./protocol"

export interface Programs {
  readonly "claude-code": AgentAdapter<AgentRole>
  readonly pi: AgentAdapter
}

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
    readonly commands: (
      engine: AgentEngine,
      folder: string,
      skills: ReadonlyArray<SkillSource>,
    ) => Effect.Effect<ReadonlyArray<AgentCommand>, HostAgentError>
    readonly start: (start: ConversationStart) => Effect.Effect<boolean, HostAgentError>
    readonly startTurn: (
      agentId: string,
      turnId: string,
      message: DeliveredMessage,
      settings: TurnSettings,
    ) => Effect.Effect<void, HostAgentError>
    readonly steer: (
      agentId: string,
      message: DeliveredMessage,
    ) => Effect.Effect<void, HostAgentError>
    readonly stopTurn: (agentId: string) => Effect.Effect<SteersNotTakenIn | null>
    readonly answer: (
      agentId: string,
      requestId: string,
      answer: RequestAnswer,
    ) => Effect.Effect<void, RequestNotWaiting | HostAgentError>
    readonly stop: (agentId: string) => Effect.Effect<void>
  }
>()("@glass/server/agentHost/HostAgents") {
  static readonly make = (adapters: Programs) =>
    Layer.effect(
      HostAgents,
      Effect.gen(function* () {
        const journal = yield* Journal
        const fs = yield* FileSystem.FileSystem

        const written = (folder: string, skills: ReadonlyArray<SkillSource>) =>
          writeSentSkills(folder, skills).pipe(Effect.provideService(FileSystem.FileSystem, fs))

        const hostScope = yield* Scope.Scope
        const running = new Map<string, Running>()
        const lock = yield* Semaphore.make(1)

        const start = Effect.fn("HostAgents.start")(
          function* (starting: ConversationStart) {
            const { agentId, folder } = starting
            const current = running.get(agentId)

            if (current !== undefined && !(yield* current.session.stopped)) return false

            const scope = yield* Scope.fork(hostScope)
            const report = (event: AgentEvent) => journal.append(agentId, event)

            const started = Effect.gen(function* () {
              const skills = yield* written(
                folder,
                Predicate.isTagged(starting.role, "Work") ? starting.role.skills : [],
              )

              return yield* starting.engine === "pi"
                ? adapters.pi.start({
                    folder,
                    conversation: agentId,
                    role: starting.role,
                    skills,
                    report,
                  })
                : adapters["claude-code"].start({
                    folder,
                    conversation: agentId,
                    role: starting.role,
                    skills,
                    report,
                  })
            })

            const session = yield* started.pipe(
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

            return true
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
          commands: (engine, folder, skills) =>
            written(folder, skills).pipe(
              Effect.flatMap((paths) => adapters[engine].commands(folder, paths)),
              Effect.scoped,
            ),
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
