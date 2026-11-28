import {
  getAgentDir,
  type ModelRuntime,
  resolveModelScopeWithDiagnostics,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import {
  type AgentCommand,
  type AgentModel,
  AgentModels,
  AgentStatusesChanged,
  type RequestAnswer,
  RequestNotWaiting,
  type RequestPart,
  SUGGEST_DRAFT_TOOL,
  type TurnMessage,
  withContextOf,
} from "@glass/contracts"
import {
  type Cause,
  Duration,
  Effect,
  FileSystem,
  Match,
  Option,
  Predicate,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect"
import { ChildProcessSpawner } from "effect/process"
import { randomUUID } from "node:crypto"
import { stripVTControlCharacters } from "node:util"
import { homedir } from "node:os"
import { join } from "node:path"
import type { HarnessAdapter } from "./adapter"
import { agentImages, type DeliveredMessage, type DeliveredTurn } from "./deliveredMessage"
import {
  AvailableCommands,
  AvailableModels,
  ClearedQueue,
  type PiModel,
  PromptAccepted,
  SessionState,
  startPiRpc,
  type PiEvent,
} from "./piRpc"
import {
  beginTurn,
  Command,
  dialogMethods,
  dialogQuestion,
  Input,
  leftover,
  machine,
  stoppedReason,
} from "./piTurn"
import { globalInstructions, PI_QUESTION_TOOL, piQuestionExtension } from "./globalRole"
import { PI_GLASS_TOOLS, piGlassToolsExtension } from "./piGlassTools"
import { workInstructions } from "./workRole"
import {
  type ThreadRole,
  couldNotSwitch,
  type GlassToolsAccess,
  HostThreadError,
  notRunning,
} from "./protocol"
import { settleWith } from "./requests"
import { scopedFolder } from "./scopedFolder"
import type { WrittenSkills } from "./sentSkills"
import { piFilesFolder, piLoadsNothing, piTools } from "../agentTools"
import { piSubagentStatusExtension } from "./piSubagentStatus"
import { PI_DIFF_LINES } from "./piReviewTools"
import { SUBMIT_REVIEW_TOOL } from "./submitReviewTool"
import { runTurns } from "./turnLoop"
import { redelivery, SessionEntries } from "./piRedelivery"
import piDrawDiagramSource from "virtual:pi-draw-diagram"
import piReviewToolsSource from "virtual:pi-review-tools"

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

const modelId = ({ provider, id }: { provider: string; id: string }) => `${provider}/${id}`

const parseModelId = (glassId: string) => {
  const slash = glassId.indexOf("/")

  return slash <= 0
    ? undefined
    : { provider: glassId.slice(0, slash), id: glassId.slice(slash + 1) }
}

// WARNING: Copies getSupportedThinkingLevels from pi-ai 1.5.2; pi's RPC doesn't report thinking levels per model.
const supportedThinkingLevels = (model: PiModel) =>
  model.reasoning === true
    ? thinkingLevels.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level]

        return (
          mapped !== null && (level === "xhigh" || level === "max" ? mapped !== undefined : true)
        )
      })
    : []

const toModel = (model: PiModel): AgentModel => ({
  id: modelId(model),
  name: model.name ?? model.id,
  efforts: supportedThinkingLevels(model),
})

const inScope = (models: ReadonlyArray<PiModel>) =>
  Effect.tryPromise(async () => {
    const patterns = SettingsManager.create(homedir()).getEnabledModels() ?? []

    if (patterns.length === 0) return { scoped: [], warnings: [] }

    // SAFETY: pi-coding-agent 1.5.2's resolver reads only getAvailable() and each model's provider, id, name, and type; piAdapter.integration.test.ts catches a bump that reads more.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- See SAFETY above.
    const reported = { getAvailable: () => Promise.resolve(models) } as ModelRuntime
    const scope = await resolveModelScopeWithDiagnostics(patterns, reported)

    return {
      scoped: scope.scopedModels.flatMap(
        ({ model }) =>
          models.find(({ provider, id }) => provider === model.provider && id === model.id) ?? [],
      ),
      warnings: scope.diagnostics.map(({ message }) => message),
    }
  }).pipe(
    Effect.tap(({ warnings }) =>
      warnings.length === 0 ? Effect.void : Effect.logWarning("pi's model scope", warnings),
    ),
    Effect.map(({ scoped }) => scoped),
    Effect.tapError((error) => Effect.logWarning("pi's model scope could not be read", error)),
    Effect.orElseSucceed((): ReadonlyArray<PiModel> => []),
  )

// WARNING: Mirrors how pi-coding-agent 1.5.2's createAgentSession picks a fresh session's thinking level.
const freshThinkingLevel = (folder: string, model: { provider: string; id: string }) => {
  const settings = SettingsManager.create(folder)

  return (
    settings.getModelThinkingLevel(model.provider, model.id) ??
    settings.getDefaultThinkingLevel() ??
    "medium"
  )
}

const piMessage = (type: "prompt" | "steer", delivered: DeliveredTurn) => ({
  type,
  message: delivered.prompt,
  images: agentImages(delivered).map(({ mediaType, data }) => ({
    type: "image" as const,
    data,
    mimeType: mediaType,
  })),
})

const refused = (what: "model" | "effort") => (error: string) =>
  Effect.logWarning(`pi refused a ${what}`, error).pipe(
    Effect.andThen(Effect.fail(couldNotSwitch("pi", what))),
  )

interface PiFile {
  readonly name: string
  readonly source: string
}

interface PiFlagFile extends PiFile {
  readonly flag: "--extension" | "--append-system-prompt"
  readonly besideIt: ReadonlyArray<PiFile>
}

const extension = (
  name: string,
  source: string,
  besideIt: ReadonlyArray<PiFile> = [],
): PiFlagFile => ({ flag: "--extension", name, source, besideIt })

const instructions = (source: string): PiFlagFile => ({
  flag: "--append-system-prompt",
  name: "instructions.md",
  source,
  besideIt: [],
})

const writtenFiles = Effect.fnUntraced(function* (
  folder: string,
  files: ReadonlyArray<PiFlagFile>,
) {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* scopedFolder(piFilesFolder(folder))

  const flags = yield* Effect.forEach(files, ({ flag, name, source, besideIt }) => {
    const file = join(directory, name)

    return Effect.forEach(besideIt, (data) =>
      fs.writeFileString(join(directory, data.name), data.source),
    ).pipe(Effect.andThen(fs.writeFileString(file, source)), Effect.as([flag, file]))
  })

  return flags.flat()
})

const lockedDownFlags = (
  folder: string,
  tools: ReadonlyArray<string>,
  files: ReadonlyArray<PiFlagFile>,
) =>
  writtenFiles(folder, files).pipe(
    Effect.map((flags) => ["--tools", tools.join(","), ...piLoadsNothing, ...flags]),
  )

const skillFlags = (skills: ReadonlyArray<WrittenSkills>) =>
  skills.flatMap((plugin) => plugin.skills.flatMap((skill) => ["--skill", skill]))

const retriesDelivery = (role: ThreadRole, { context }: TurnMessage) =>
  Predicate.isTagged(role, "Global") && Predicate.isTagged(context, "Update")

const roleFlags = (
  folder: string,
  role: ThreadRole,
  glassTools: GlassToolsAccess | undefined,
  skills: ReadonlyArray<WrittenSkills>,
) =>
  Match.value(role).pipe(
    Match.tagsExhaustive({
      Work: () =>
        writtenFiles(folder, [
          extension("draw-diagram.mjs", piDrawDiagramSource),
          extension("subagent-status.js", piSubagentStatusExtension),
          ...(glassTools === undefined
            ? []
            : [extension("glass-tools.js", piGlassToolsExtension), instructions(workInstructions)]),
        ]).pipe(Effect.map((flags) => [...skillFlags(skills), ...flags])),
      Review: ({ brief }) =>
        lockedDownFlags(
          folder,
          [...piTools.review, SUBMIT_REVIEW_TOOL, SUGGEST_DRAFT_TOOL],
          [
            extension("review-tools.mjs", piReviewToolsSource, [
              { name: PI_DIFF_LINES, source: JSON.stringify(brief.diffLines) },
            ]),
            instructions(brief.instructions),
          ],
        ).pipe(
          Effect.map((flags) => [
            "--session-dir",
            join(getAgentDir(), "sessions", "glass-reviews"),
            ...flags,
          ]),
        ),
      Global: () =>
        lockedDownFlags(
          folder,
          [PI_QUESTION_TOOL, PI_GLASS_TOOLS],
          [
            extension("ask-user.js", piQuestionExtension),
            extension("glass-tools.js", piGlassToolsExtension),
            instructions(globalInstructions),
          ],
        ),
    }),
  )

const logProviderError = (event: PiEvent) =>
  event.type === "message_end" && event.message.stopReason === "error"
    ? Effect.logWarning("pi's model provider returned an error", event.message.errorMessage)
    : Effect.void

export const piAdapter = (command: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem

    const startPi = (
      folder: string,
      thread?: string,
      flags?: ReadonlyArray<string>,
      tools?: GlassToolsAccess,
      deliver?: (event: PiEvent) => Effect.Effect<void>,
    ) =>
      startPiRpc(command, folder, thread, flags, tools, deliver).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      )

    return {
      models: Effect.gen(function* () {
        const rpc = yield* startPi(homedir())

        const [available, state] = yield* Effect.all(
          [
            rpc.request({ type: "get_available_models" }, AvailableModels),
            rpc.request({ type: "get_state" }, SessionState),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.tapError((error) => Effect.logWarning("pi didn't list its models", error)),
          Effect.mapError(
            () => new HostThreadError({ message: "pi didn't list its models. Try again." }),
          ),
        )

        const scoped = yield* inScope(available.models)

        return new AgentModels({
          defaultModel: state.model == null ? null : toModel(state.model),
          models: (scoped.length > 0 ? scoped : available.models).map(toModel),
        })
      }).pipe(Effect.scoped),

      commands: (folder: string, skills: ReadonlyArray<WrittenSkills>) =>
        Effect.gen(function* () {
          const rpc = yield* startPi(folder, undefined, skillFlags(skills))

          const { commands } = yield* rpc.request({ type: "get_commands" }, AvailableCommands).pipe(
            Effect.tapError((error) => Effect.logWarning("pi didn't list its commands", error)),
            Effect.mapError(
              () => new HostThreadError({ message: "pi didn't list its commands. Try again." }),
            ),
          )

          return commands.map(({ name, description }): AgentCommand => ({
            name,
            description: description ?? "",
          }))
        }).pipe(Effect.scoped),

      start: Effect.fnUntraced(function* ({ folder, thread, role, glassTools, skills, report }) {
        const scope = yield* Scope.Scope

        const flags = yield* roleFlags(folder, role, glassTools, skills).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.tapError((error) => Effect.logWarning("Couldn't prepare pi's tools", error)),
          Effect.mapError(
            () => new HostThreadError({ message: "Couldn't prepare pi's tools. Try again." }),
          ),
        )

        const inbox = yield* Queue.unbounded<Input, Cause.Done>()
        const dialogs = new Map<string, { readonly method: string; readonly part: RequestPart }>()

        const expire = (id: string) =>
          Effect.suspend(() =>
            dialogs.delete(id) ? Queue.offer(inbox, Input.Expired({ requestId: id })) : Effect.void,
          )

        const trackDialog = (event: PiEvent) => {
          if (event.type !== "extension_ui_request" || !dialogMethods.has(event.method))
            return Effect.void

          dialogs.set(event.id, { method: event.method, part: dialogQuestion(event) })

          return event.timeout === undefined
            ? Effect.void
            : expire(event.id).pipe(
                Effect.delay(Duration.millis(event.timeout)),
                Effect.forkIn(scope),
                Effect.asVoid,
              )
        }

        const statuses = new Map<string, string>()

        const showStatuses = Effect.suspend(() =>
          report(AgentStatusesChanged.make({ agentStatuses: [...statuses.values()] })),
        )

        const trackStatus = (event: PiEvent) => {
          if (
            event.type !== "extension_ui_request" ||
            event.method !== "setStatus" ||
            event.statusKey === undefined
          )
            return Effect.void

          const text = stripVTControlCharacters(event.statusText ?? "").trim()

          if (text === "") statuses.delete(event.statusKey)
          else statuses.set(event.statusKey, text)

          return showStatuses
        }

        const rpc = yield* startPi(folder, thread, flags, glassTools, (event) =>
          trackDialog(event).pipe(
            Effect.andThen(trackStatus(event)),
            Effect.andThen(logProviderError(event)),
            Effect.andThen(Queue.offer(inbox, Input.Event({ event }))),
            Effect.asVoid,
          ),
        )

        yield* rpc.exited.pipe(
          Effect.andThen(Queue.end(inbox)),
          Effect.andThen(
            Effect.suspend(() => {
              if (statuses.size === 0) return Effect.void
              statuses.clear()

              return showStatuses
            }),
          ),
          Effect.forkIn(scope),
        )

        const startingModel = (yield* rpc.request({ type: "get_state" }, SessionState).pipe(
          Effect.tapError((error) => Effect.logWarning("pi didn't report its state", error)),
          Effect.mapError(() => new HostThreadError({ message: stoppedReason })),
        )).model

        const turns = yield* runTurns({
          harness: "pi",
          machine: {
            ...machine,
            begin: (turnId, sent, at) => beginTurn(turnId, sent, at, retriesDelivery(role, sent)),
          },
          events: Stream.fromQueue(inbox),
          report,
          run: (piCommand, offer) =>
            Command.$match(piCommand, {
              CheckIdle: ({ generation }) =>
                rpc.request({ type: "get_state" }, SessionState).pipe(
                  Effect.map((state) => !state.isStreaming && !state.isCompacting),
                  Effect.orElseSucceed(() => true),
                  Effect.flatMap((idle) => offer(Input.Idle({ idle, generation }))),
                  Effect.forkIn(scope),
                  Effect.asVoid,
                ),
              DeclineDialog: ({ id }) =>
                Effect.sync(() => dialogs.delete(id)).pipe(
                  Effect.andThen(rpc.send({ type: "extension_ui_response", id, cancelled: true })),
                ),
              Resume: ({ turnId, steers }) =>
                Effect.gen(function* () {
                  const [first, ...rest] = steers

                  if (first === undefined) return

                  yield* rpc.request({ type: "clear_queue" }, ClearedQueue)
                  yield* rpc.request(piMessage("prompt", first), PromptAccepted)
                  yield* Effect.forEach(
                    rest,
                    (steer) => rpc.request(piMessage("steer", steer), PromptAccepted),
                    { discard: true },
                  )
                }).pipe(
                  Effect.tapError((error) => Effect.logWarning("pi refused a held Steer", error)),
                  Effect.catch(() => offer(Input.Refused({ turnId }))),
                  Effect.forkIn(scope),
                  Effect.asVoid,
                ),
            }),
        })

        const startMessage = Effect.fnUntraced(function* (turnId: string, sent: DeliveredTurn) {
          yield* turns.begin(turnId, withContextOf(sent))

          const answer = yield* rpc.request(piMessage("prompt", sent), PromptAccepted).pipe(
            Effect.map(({ disposition }) =>
              Input.Accepted({ turnId, handled: disposition === "handled" }),
            ),
            Effect.tapError((error) => Effect.logWarning("pi refused a message", error)),
            Effect.orElseSucceed(() => Input.Refused({ turnId })),
          )

          yield* Queue.offer(inbox, answer)
        })

        const startRedelivered = Effect.fnUntraced(function* (turnId: string, sent: DeliveredTurn) {
          const delivery = yield* rpc.request({ type: "get_entries" }, SessionEntries).pipe(
            Effect.map((session) => redelivery(turnId, sent.prompt, session)),
            Effect.tapError((error) =>
              Effect.logWarning("Couldn't recover what pi was sent before Glass restarted", error),
            ),
            Effect.mapError(
              () =>
                new HostThreadError({
                  message:
                    "Couldn't recover what pi was sent before Glass restarted. Restart Glass to try again.",
                }),
            ),
          )

          yield* turns.begin(turnId, withContextOf(sent))

          for (const event of delivery.events) yield* Queue.offer(inbox, Input.Event({ event }))

          if (delivery.state === "completed") {
            yield* Queue.offer(inbox, Input.Idle({ idle: true, generation: 0 }))

            return
          }

          const { disposition } = yield* rpc
            .request(piMessage("prompt", { ...sent, prompt: delivery.prompt }), PromptAccepted)
            .pipe(
              Effect.tapError(() => Queue.offer(inbox, Input.Refused({ turnId }))),
              Effect.tapError((error) =>
                Effect.logWarning("Couldn't confirm pi got the Turn again", error),
              ),
              Effect.mapError(
                () =>
                  new HostThreadError({
                    message: "Couldn't confirm pi got the Turn again. Restart Glass to try again.",
                  }),
              ),
            )

          yield* Queue.offer(inbox, Input.Accepted({ turnId, handled: disposition === "handled" }))
        })

        return {
          closed: turns.closed,
          stopped: turns.stopped,
          configure: Effect.fnUntraced(function* ({ model, effort }) {
            const target = model === null ? startingModel : parseModelId(model)

            if (model !== null && target === undefined) return yield* refused("model")(model)

            if (target != null)
              yield* rpc
                .request(
                  { type: "set_model", provider: target.provider, modelId: target.id },
                  Schema.Unknown,
                )
                .pipe(Effect.catch(refused("model")))

            const level = effort ?? (target == null ? null : freshThinkingLevel(folder, target))

            if (level !== null)
              yield* rpc
                .request({ type: "set_thinking_level", level }, Schema.Unknown)
                .pipe(Effect.catch(refused("effort")))

            return undefined
          }),
          startTurn: (turnId, sent) =>
            retriesDelivery(role, sent)
              ? startRedelivered(turnId, sent)
              : startMessage(turnId, sent),
          answer: Effect.fnUntraced(function* (requestId: string, answer: RequestAnswer) {
            const dialog = dialogs.get(requestId)

            if (dialog === undefined) return yield* new RequestNotWaiting()

            const settled = yield* settleWith(dialog.part, answer)
            const [reply] = Predicate.isTagged(settled, "Question") ? (settled.answers ?? []) : []
            const value = reply?.text ?? reply?.chosen[0] ?? ""

            dialogs.delete(requestId)
            yield* Queue.offer(inbox, Input.Answered({ requestId, answer }))
            yield* rpc.send(
              dialog.method === "confirm"
                ? { type: "extension_ui_response", id: requestId, confirmed: value === "Yes" }
                : { type: "extension_ui_response", id: requestId, value },
            )

            return undefined
          }),
          steer: Effect.fnUntraced(function* (sent: DeliveredMessage) {
            const steer = { ...sent, id: randomUUID() }

            if (!(yield* turns.steer(steer))) return yield* notRunning

            const accepted = yield* rpc.request(piMessage("steer", sent), PromptAccepted).pipe(
              Effect.map(({ disposition }) => disposition),
              Effect.tapError((error) => Effect.logWarning("pi refused a Steer", error)),
              Effect.option,
            )

            if (Option.isSome(accepted) && accepted.value !== "handled") return undefined

            yield* turns.dropSteer(steer.id)

            if (Option.isSome(accepted))
              return yield* Queue.offer(inbox, Input.SteerHandled({ steer }))

            return yield* new HostThreadError({ message: "pi didn't take the message in." })
          }),
          stopBackgroundTask: () =>
            Effect.fail(new HostThreadError({ message: "pi has no background tasks to stop." })),
          stopTurn: (turnId, ending) =>
            Effect.gen(function* () {
              const steers = yield* turns.stop(turnId, ending)

              if (steers === null) return null

              const cleared = yield* rpc.request({ type: "clear_queue" }, ClearedQueue).pipe(
                Effect.tapError((error) => Effect.logWarning("pi didn't clear its queue", error)),
                Effect.orElseSucceed(() => ({ steering: [], followUp: [] })),
              )

              // WARNING: An open dialog blocks its extension, and with it pi's run, until it's answered (pi docs/rpc-extension-ui.md).
              const open = Array.from(dialogs.keys())
              dialogs.clear()
              yield* Effect.forEach(
                open,
                (id) => rpc.send({ type: "extension_ui_response", id, cancelled: true }),
                { discard: true },
              ).pipe(Effect.ignore)

              yield* rpc
                .request({ type: "abort" }, Schema.Unknown)
                .pipe(
                  Effect.ignore({ log: "Warn", message: "pi didn't abort" }),
                  Effect.forkIn(scope),
                )

              return leftover(steers, cleared)
            }),
        }
      }),
    } satisfies HarnessAdapter
  })
