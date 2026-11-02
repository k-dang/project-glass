import { type AgentEngine, runnerIdentity } from "@glass/contracts"
import { Deferred, Effect, Layer, Schema } from "effect"
import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { agentFailure, type AgentFailure } from "../src/agentFailure"
import { type AgentTask, AgentRunners } from "../src/agentRunners"
import { counter } from "./counter"

export type ScriptedReply =
  | { readonly answer: unknown }
  | { readonly fail: AgentFailure["reason"] }
  | "hold"

export interface ScriptedSettings {
  readonly reply: ScriptedReply
  readonly ready?: "ready" | "hang" | AgentFailure["reason"]
}

interface ScriptedRun {
  readonly engine: AgentEngine
  readonly task: AgentTask<unknown>
  readonly directory: string | null
  readonly files: ReadonlyArray<string>
}

const filesIn = (directory: string) =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .toSorted()

export const scriptedAgentRunners = Effect.fnUntraced(function* (initial: ScriptedSettings) {
  let settings = initial
  let held = yield* Deferred.make<void>()
  const selections: Array<AgentEngine> = []
  const runs: Array<ScriptedRun> = []
  const selecting = counter()
  const started = counter()
  const interrupted = counter()

  const answer = <A>(task: AgentTask<A>, reply: ScriptedReply): Effect.Effect<A, AgentFailure> =>
    reply === "hold"
      ? Deferred.await(held).pipe(Effect.flatMap(() => answer(task, settings.reply)))
      : "fail" in reply
        ? Effect.fail(agentFailure(reply.fail, `The scripted runner failed: ${reply.fail}.`))
        : Schema.decodeUnknownEffect(task.answer)(reply.answer).pipe(
            Effect.mapError(() =>
              agentFailure(
                "unusable-output",
                `The scripted runner's ${task.subject} won't decode.`,
              ),
            ),
          )

  const layer = Layer.succeed(
    AgentRunners,
    AgentRunners.of({
      select: (engineSettings) =>
        Effect.gen(function* () {
          const ready = settings.ready ?? "ready"
          selections.push(engineSettings.engine)
          selecting.add()

          if (ready === "hang") return yield* Effect.never

          if (ready !== "ready")
            return yield* agentFailure(ready, `The scripted runner isn't ready: ${ready}.`)
          const identity = runnerIdentity(engineSettings)

          return {
            identity,
            run: <A>(task: AgentTask<A>) =>
              Effect.suspend(() => {
                // Effect resumes a waiting test synchronously inside `started.add()`, before this
                // returns, so the reply and any hold are fixed first.
                const answering = answer(task, settings.reply)
                runs.push({
                  engine: engineSettings.engine,
                  task,
                  directory: task.files === "none" ? null : task.files.readOnly,
                  files: task.files === "none" ? [] : filesIn(task.files.readOnly),
                })
                started.add()

                return answering
              }).pipe(
                Effect.mapError((failure) =>
                  agentFailure(failure.reason, failure.message, identity),
                ),
                Effect.onInterrupt(() => Effect.sync(interrupted.add)),
              ),
          }
        }).pipe(Effect.onInterrupt(() => Effect.sync(interrupted.add))),
    }),
  )

  return {
    layer,
    selections,
    runs,
    selected: selecting.reached,
    ran: started.reached,
    interrupted: interrupted.reached,
    configure: (next: ScriptedSettings) =>
      Effect.sync(() => {
        settings = next
      }),
    release: (reply: ScriptedReply) =>
      Effect.gen(function* () {
        settings = { ...settings, reply }
        const releasing = held
        held = yield* Deferred.make<void>()
        yield* Deferred.succeed(releasing, undefined)
      }),
  }
})
