import {
  AgentModels,
  PartSet,
  PermissionRequestPart,
  QuestionPart,
  type RequestPart,
  RequestNotWaiting,
  type MessageWithContext,
  SteerPart,
  SUGGEST_DRAFT_TOOL,
  TextPart,
  ToolCallPart,
  TurnDone,
  TurnEnded,
  TurnStarted,
  type TurnEnding,
  TurnFailed,
  withContextOf,
} from "@glass/contracts"
import { DateTime, Deferred, Effect, Fiber, Predicate, Schema, Scope } from "effect"
import { randomUUID } from "node:crypto"
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { HarnessAdapter, HarnessSession } from "../src/agentHost/adapter"
import type { DeliveredTurn } from "../src/agentHost/deliveredMessage"
import { GlassToolsAccess, notRunning } from "../src/agentHost/protocol"
import type { WrittenSkills } from "../src/agentHost/sentSkills"
import { MCP_PATH } from "../src/mcp/mcpHttp"
import { filesIn } from "./filesIn"
import { connectMcp, initialize, mcpPost } from "./mcpClient"
import { settleWith } from "../src/agentHost/requests"
import { placeSuggestedDraft } from "../src/agentHost/suggestDraftTool"
import { SUBMIT_REVIEW_TOOL, submitReview } from "../src/agentHost/submitReviewTool"
import { whenExists } from "./whenExists"

interface Waiting {
  readonly part: RequestPart
  readonly index: number
  readonly answered: Deferred.Deferred<void>
}

const callGlass = (access: GlassToolsAccess, name: string, args: Schema.JsonObject) =>
  Effect.gen(function* () {
    const baseUrl = access.url.slice(0, -MCP_PATH.length)
    const opened = yield* mcpPost(baseUrl, initialize, { bearer: access.bearer })

    if (opened.status !== 200) return { output: `Refused with ${opened.status}`, done: false }

    const mcp = yield* connectMcp(baseUrl, access.bearer)
    const result = yield* mcp.call(name, args)

    return { output: JSON.stringify(result.content), done: result.isError !== true }
  })

const AccessJson = Schema.fromJsonString(GlassToolsAccess)

const encodeAccess = Schema.encodeSync(AccessJson)

const decodeAccess = Schema.decodeSync(AccessJson)

const scriptedCall = /^call(?<ended>-ended)?:(?<name>\S+)(?: (?<args>.+))?$/m

const scriptedUpdateCall = /^on-update:(?<name>\S+)(?: (?<args>.+))?$/m

const scriptedUnprompted = /^then-unprompted:(?<name>\S+)(?: (?<args>.+))?$/m

const scriptedDuringUpdate = /^during-update:(.+)$/gm

const scriptedHold = /^hold:(\S+)/m

const decodeArgs = Schema.decodeSync(Schema.fromJsonString(Schema.JsonObject))

export const REVIEW_SCRIPT = "review.json"

const ReviewScript = Schema.Struct({
  hold: Schema.optional(Schema.String),
  submit: Schema.optional(Schema.Array(Schema.Unknown)),
  fail: Schema.optional(Schema.String),
})

export type ReviewScript = typeof ReviewScript.Type

const decodeReviewScript = Schema.decodeSync(Schema.fromJsonString(ReviewScript))

export const reviewStopped = (thread: string) => `review-stopped-${thread}`

export const reviewPrompt = (thread: string) => `review-prompt-${thread}`

const reviewScript = (gates: string): ReviewScript => {
  const path = join(gates, REVIEW_SCRIPT)

  return existsSync(path) ? decodeReviewScript(readFileSync(path, "utf8")) : {}
}

const skillCommands = (written: ReadonlyArray<WrittenSkills>) =>
  written.flatMap(({ plugin, skills }) =>
    skills.map((skill) => ({ name: `${basename(plugin)}:${basename(skill)}`, description: "" })),
  )

export const scriptedAdapter = (gates: string): HarnessAdapter => {
  const currentStart = join(gates, "global-start.json")
  const previousStart = join(gates, "previous-global-start.json")

  const earlierStart = Effect.suspend(() =>
    existsSync(previousStart)
      ? Effect.succeed(decodeAccess(readFileSync(previousStart, "utf8")))
      : Effect.die("The Global chat has no earlier start"),
  )

  return {
    models: Effect.succeed(
      new AgentModels({
        defaultModel: null,
        models: [{ id: "scripted", name: "Scripted", efforts: [] }],
      }),
    ),
    commands: (_folder, skills) => Effect.succeed(skillCommands(skills)),
    start: ({ folder, thread, role, glassTools, skills, report }) =>
      Effect.gen(function* () {
        const review = Predicate.isTagged(role, "Review") ? role.brief : null
        const glass = glassTools ?? null
        const scope = yield* Scope.Scope

        if (Predicate.isTagged(role, "Global")) {
          if (existsSync(currentStart)) renameSync(currentStart, previousStart)
          writeFileSync(currentStart, encodeAccess(role.tools))
        }

        let turn: {
          readonly id: string
          readonly fiber: Fiber.Fiber<void>
          steers: Array<MessageWithContext>
          index: number
          waiting: Waiting | null
        } | null = null

        const part = (turnId: string, set: typeof PartSet.Type.part) =>
          Effect.suspend(() => {
            const index = turn!.index++

            return report(PartSet.make({ turnId, index, part: set })).pipe(Effect.as(index))
          })

        const waitFor = (turnId: string, request: RequestPart) =>
          Effect.gen(function* () {
            const answered = yield* Deferred.make<void>()
            const index = yield* part(turnId, request)
            turn!.waiting = { part: request, index, answered }
            yield* Deferred.await(answered)
          })

        const end = (turnId: string, ending: TurnEnding) =>
          Effect.gen(function* () {
            turn = null
            yield* report(TurnEnded.make({ turnId, ended: { at: yield* DateTime.now, ending } }))
          })

        const runReview = (turnId: string, prompt: string) =>
          Effect.gen(function* () {
            writeFileSync(join(gates, reviewPrompt(thread)), prompt)
            const { hold } = reviewScript(gates)

            yield* part(turnId, TextPart.make({ text: readdirSync(folder).toSorted().join(",") }))

            if (hold !== undefined) {
              yield* part(turnId, TextPart.make({ text: "Holding." }))
              yield* Effect.promise((signal) => whenExists(join(gates, hold), signal))
            }

            const script = reviewScript(gates)

            for (const answer of script.submit ?? []) {
              const { accepted, text } = submitReview(answer)

              yield* part(
                turnId,
                ToolCallPart.make({
                  toolCallId: randomUUID(),
                  name: SUBMIT_REVIEW_TOOL,
                  inputSummary: "",
                  input: JSON.stringify(answer),
                  output: text,
                  status: accepted ? "done" : "failed",
                  parentToolCallId: null,
                }),
              )
            }

            yield* end(
              turnId,
              script.fail === undefined
                ? TurnDone.make({})
                : TurnFailed.make({ reason: script.fail }),
            )
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => writeFileSync(join(gates, reviewStopped(thread)), "")),
            ),
          )

        const begin = (turnId: string, work: Effect.Effect<void>) =>
          Effect.gen(function* () {
            const fiber = yield* work.pipe(Effect.forkIn(scope))
            turn = { id: turnId, fiber, steers: [], index: 0, waiting: null }
          })

        const called = (turnId: string, access: GlassToolsAccess, name: string, args: string) =>
          Effect.gen(function* () {
            const { output, done } = yield* callGlass(access, name, decodeArgs(args))

            yield* part(
              turnId,
              ToolCallPart.make({
                toolCallId: randomUUID(),
                name,
                inputSummary: "",
                input: args,
                output,
                status: done ? "done" : "failed",
                parentToolCallId: null,
              }),
            )
          })

        const run = (turnId: string, { message, prompt, context }: DeliveredTurn) =>
          Effect.gen(function* () {
            const update =
              Predicate.isTagged(context, "StartedWorkUpdate") ||
              Predicate.isTagged(context, "Update")

            const scripted = update ? scriptedUpdateCall.exec(prompt) : scriptedCall.exec(message)

            const script = update
              ? Array.from(prompt.matchAll(scriptedDuringUpdate), ([, line]) => line).join("\n")
              : message

            if (scripted !== null && glass !== null) {
              const { ended, name, args = "{}" } = scripted.groups!

              yield* called(turnId, ended === undefined ? glass : yield* earlierStart, name!, args)
            }

            const hold = scriptedHold.exec(script)?.[1]

            if (hold !== undefined) {
              yield* part(turnId, TextPart.make({ text: "Holding." }))
              yield* Effect.promise((signal) => whenExists(join(gates, hold), signal))

              for (const steer of turn!.steers.splice(0)) {
                yield* part(turnId, SteerPart.make(withContextOf(steer)))
                yield* part(turnId, TextPart.make({ text: `Reply to: ${steer.message}` }))
              }
            }

            const suggestion = /^suggest (new|old):(\S+):(\d+) (.+)$/.exec(message)

            if (suggestion !== null && review !== null) {
              const [, side, path, line, body] = suggestion

              const draft = {
                path: path!,
                side: side === "old" ? ("old" as const) : ("new" as const),
                line: Number(line),
                body: body!,
              }

              const { accepted, text } = placeSuggestedDraft(review.diffLines, draft)

              yield* part(
                turnId,
                ToolCallPart.make({
                  toolCallId: randomUUID(),
                  name: SUGGEST_DRAFT_TOOL,
                  inputSummary: path!,
                  input: JSON.stringify(draft),
                  output: text,
                  status: accepted ? "done" : "failed",
                  parentToolCallId: null,
                }),
              )
            }

            if (message === "show the skills") {
              const [first] = skills
              const written = first === undefined ? [] : filesIn(dirname(first.plugin))

              yield* part(turnId, TextPart.make({ text: written.join(",") }))
            }

            if (message === "show the session") yield* part(turnId, TextPart.make({ text: thread }))

            if (message === "show the review" && review !== null) {
              yield* part(turnId, TextPart.make({ text: review.instructions }))
              yield* part(turnId, TextPart.make({ text: readdirSync(folder).toSorted().join(",") }))
            }

            if (/ask permission/i.test(script)) {
              yield* waitFor(
                turnId,
                PermissionRequestPart.make({
                  requestId: randomUUID(),
                  toolName: "Bash",
                  inputSummary: "touch notes.txt",
                  input: JSON.stringify({ command: "touch notes.txt" }),
                  status: "waiting",
                  reason: null,
                }),
              )
            }

            if (/ask a question/i.test(script)) {
              yield* waitFor(
                turnId,
                QuestionPart.make({
                  requestId: randomUUID(),
                  questions: [
                    {
                      header: null,
                      question: "Which files should change?",
                      detail: null,
                      options: [{ label: "Only source files", description: null }],
                      multiSelect: false,
                      freeText: true,
                    },
                  ],
                  status: "waiting",
                  answers: null,
                }),
              )
            }

            if (prompt.includes("<glass_feedback>") || Predicate.isTagged(context, "Update"))
              yield* part(turnId, TextPart.make({ text: prompt }))

            yield* part(turnId, TextPart.make({ text: `Reply to: ${message}` }))
            yield* end(turnId, TurnDone.make({}))

            const unprompted = scriptedUnprompted.exec(message)

            if (unprompted !== null && glass !== null) {
              const { name, args = "{}" } = unprompted.groups!
              const id = randomUUID()

              yield* begin(
                id,
                Effect.gen(function* () {
                  yield* report(
                    TurnStarted.make({
                      turnId: id,
                      message: "",
                      images: [],
                      context: null,
                      feedback: [],
                      sentAt: yield* DateTime.now,
                    }),
                  )
                  yield* called(id, glass, name!, args)
                  yield* end(id, TurnDone.make({}))
                }),
              )
            }
          })

        return {
          configure: () => Effect.void,
          startTurn: (turnId, message) =>
            begin(
              turnId,
              review !== null && Predicate.isTagged(message.context, "AgentReview")
                ? runReview(turnId, message.prompt)
                : run(turnId, message),
            ),
          steer: (message) =>
            turn === null ? notRunning : Effect.sync(() => void turn!.steers.push(message)),
          stopBackgroundTask: () => Effect.void,
          stopTurn: (turnId, ending) =>
            Effect.gen(function* () {
              if (turn === null || turn.id !== turnId) return null

              const { id, fiber, steers } = turn

              yield* Fiber.interrupt(fiber)
              yield* end(id, ending)

              return steers
            }),
          answer: (requestId, answer) =>
            Effect.gen(function* () {
              const waiting = turn?.waiting

              if (waiting == null || waiting.part.requestId !== requestId)
                return yield* new RequestNotWaiting()

              const settled = yield* settleWith(waiting.part, answer)
              turn!.waiting = null
              yield* report(PartSet.make({ turnId: turn!.id, index: waiting.index, part: settled }))
              yield* Deferred.succeed(waiting.answered, undefined)

              return undefined
            }),
          closed: Effect.never,
          stopped: Effect.succeed(false),
        } satisfies HarnessSession
      }),
  }
}
