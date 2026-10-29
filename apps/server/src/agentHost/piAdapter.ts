import {
  type ModelRuntime,
  resolveModelScopeWithDiagnostics,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import {
  type AgentModel,
  AgentModels,
  type RequestAnswer,
  RequestNotWaiting,
  type RequestPart,
  type SentMessage,
} from "@glass/contracts"
import { Duration, Effect, Option, Predicate, Queue, Schema, Scope, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import type { AgentAdapter } from "./adapter"
import {
  AvailableModels,
  ClearedQueue,
  type PiModel,
  PromptAccepted,
  SessionState,
  startPiRpc,
} from "./piRpc"
import {
  Command,
  dialogMethods,
  dialogQuestion,
  Input,
  leftover,
  machine,
  stoppedReason,
} from "./piTurn"
import { couldNotSwitch, HostAgentError, notRunning } from "./protocol"
import { settleWith } from "./requests"
import { runTurns } from "./turnLoop"

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

const modelId = ({ provider, id }: { provider: string; id: string }) => `${provider}/${id}`

const parseModelId = (glassId: string) => {
  const slash = glassId.indexOf("/")

  return slash <= 0
    ? undefined
    : { provider: glassId.slice(0, slash), id: glassId.slice(slash + 1) }
}

/**
 * The thinking levels pi offers a model. pi's RPC doesn't report them per model, so this copies
 * `getSupportedThinkingLevels` from pi-ai 1.3.0. Agents run the user's own `pi`, which clamps a
 * level its model doesn't take to the nearest one it does, so drift only mislabels a choice.
 */
const toModel = (model: PiModel): AgentModel => ({
  id: modelId(model),
  name: model.name ?? model.id,
  efforts:
    model.reasoning === true
      ? thinkingLevels.filter((level) => {
          const mapped = model.thinkingLevelMap?.[level]

          return (
            mapped !== null && (level === "xhigh" || level === "max" ? mapped !== undefined : true)
          )
        })
      : [],
})

/**
 * The models the user scoped pi to (`enabledModels`), in their order, or none when unscoped. pi's
 * RPC lists every model it has credentials for, so this runs pi's own resolver over that list,
 * which holds the providers pi's extensions register.
 */
const inScope = (models: ReadonlyArray<PiModel>) =>
  Effect.tryPromise(async () => {
    const patterns = SettingsManager.create(homedir()).getEnabledModels() ?? []

    if (patterns.length === 0) return { scoped: [], warnings: [] }

    // SAFETY: pi-coding-agent 1.3.0's resolver reads only `getAvailable()` from the runtime, and
    // only the `provider`, `id`, `name`, and `type` (absent, meaning a chat model) of its models.
    // The scope test in Agents.test.ts catches a pi bump that reads more.
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

/**
 * The thinking level a fresh pi session starts a model on, as pi-coding-agent 1.3.0's
 * `createAgentSession` picks it. Switching model keeps the current level instead of this one.
 */
const freshThinkingLevel = (folder: string, model: { provider: string; id: string }) => {
  const settings = SettingsManager.create(folder)

  return (
    settings.getModelThinkingLevel(model.provider, model.id) ??
    settings.getDefaultThinkingLevel() ??
    "medium"
  )
}

const piMessage = (type: "prompt" | "steer", { message, images }: SentMessage) => ({
  type,
  message,
  images: images.map(({ mediaType, data }) => ({
    type: "image" as const,
    data,
    mimeType: mediaType,
  })),
})

const refused = (what: "model" | "effort") => (error: string) =>
  Effect.logWarning(`pi refused a ${what}`, error).pipe(
    Effect.andThen(Effect.fail(couldNotSwitch("pi", what))),
  )

export const piAdapter = (command: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const startPi = (folder: string, conversation?: string) =>
      startPiRpc(command, folder, conversation).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      )

    return {
      models: Effect.gen(function* () {
        const rpc = yield* startPi(homedir())

        const [available, state] = yield* Effect.all([
          rpc.request({ type: "get_available_models" }, AvailableModels),
          rpc.request({ type: "get_state" }, SessionState),
        ]).pipe(
          Effect.tapError((error) => Effect.logWarning("pi didn't list its models", error)),
          Effect.mapError(
            () => new HostAgentError({ message: "pi didn't list its models. Try again." }),
          ),
        )

        const scoped = yield* inScope(available.models)

        return new AgentModels({
          defaultModel: state.model == null ? null : toModel(state.model),
          // Like pi, a scope that matches none of its models scopes nothing.
          models: (scoped.length > 0 ? scoped : available.models).map(toModel),
        })
      }).pipe(Effect.scoped),

      start: Effect.fnUntraced(function* ({ folder, conversation, report }) {
        const scope = yield* Scope.Scope
        const rpc = yield* startPi(folder, conversation)

        const startingModel = (yield* rpc.request({ type: "get_state" }, SessionState).pipe(
          Effect.tapError((error) => Effect.logWarning("pi didn't report its state", error)),
          Effect.mapError(() => new HostAgentError({ message: stoppedReason })),
        )).model

        const settles = yield* Queue.unbounded<Input>()
        // Each dialog pi waits on an answer to, with the method that says how to answer it.
        const dialogs = new Map<string, { readonly method: string; readonly part: RequestPart }>()

        const expire = (id: string) =>
          Effect.suspend(() =>
            dialogs.delete(id)
              ? Queue.offer(settles, Input.Settled({ requestId: id, answer: null }))
              : Effect.void,
          )

        const turns = yield* runTurns({
          program: "pi",
          machine,
          events: rpc.events.pipe(
            Stream.tap((event) => {
              if (event.type !== "extension_ui_request" || !dialogMethods.has(event.method))
                return Effect.void

              dialogs.set(event.id, { method: event.method, part: dialogQuestion(event) })

              // pi answers a dialog itself once its timeout passes.
              return event.timeout === undefined
                ? Effect.void
                : expire(event.id).pipe(
                    Effect.delay(Duration.millis(event.timeout)),
                    Effect.forkIn(scope),
                    Effect.asVoid,
                  )
            }),
            Stream.tap((event) =>
              event.type === "message_end" && event.message.stopReason === "error"
                ? Effect.logWarning(
                    "pi's model provider returned an error",
                    event.message.errorMessage,
                  )
                : Effect.void,
            ),
            Stream.map((event) => Input.Event({ event })),
            Stream.merge(Stream.fromQueue(settles), { haltStrategy: "left" }),
          ),
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
          startTurn: Effect.fnUntraced(function* (turnId: string, sent: SentMessage) {
            yield* turns.begin(turnId, sent)

            const answer = yield* rpc.request(piMessage("prompt", sent), PromptAccepted).pipe(
              Effect.map(({ disposition }) =>
                Input.Accepted({ turnId, handled: disposition === "handled" }),
              ),
              Effect.tapError((error) => Effect.logWarning("pi refused a message", error)),
              Effect.orElseSucceed(() => Input.Refused({ turnId })),
            )

            return yield* turns.offer(answer)
          }),
          answer: Effect.fnUntraced(function* (requestId: string, answer: RequestAnswer) {
            const dialog = dialogs.get(requestId)

            if (dialog === undefined) return yield* new RequestNotWaiting()

            const settled = yield* settleWith(dialog.part, answer)
            const [reply] = Predicate.isTagged(settled, "Question") ? (settled.answers ?? []) : []
            const value = reply?.text ?? reply?.chosen[0] ?? ""

            dialogs.delete(requestId)
            yield* Queue.offer(settles, Input.Settled({ requestId, answer }))
            yield* rpc.send(
              dialog.method === "confirm"
                ? { type: "extension_ui_response", id: requestId, confirmed: value === "Yes" }
                : { type: "extension_ui_response", id: requestId, value },
            )

            return undefined
          }),
          steer: Effect.fnUntraced(function* (sent: SentMessage) {
            const id = randomUUID()

            if (!(yield* turns.steer({ ...sent, id }))) return yield* notRunning

            const accepted = yield* rpc.request(piMessage("steer", sent), PromptAccepted).pipe(
              Effect.map(({ disposition }) => disposition),
              Effect.tapError((error) => Effect.logWarning("pi refused a Steer", error)),
              Effect.option,
            )

            if (Option.isSome(accepted))
              return accepted.value === "handled"
                ? yield* turns.offer(Input.SteerHandled({ id }))
                : undefined

            yield* turns.dropSteer(id)

            return yield* new HostAgentError({ message: "pi didn't take the message in." })
          }),
          // pi's abort runs whatever it still holds, so the queue is cleared first (pi docs/rpc-commands.md).
          stopTurn: Effect.gen(function* () {
            const steers = yield* turns.stop

            if (steers === null) return null

            const cleared = yield* rpc.request({ type: "clear_queue" }, ClearedQueue).pipe(
              Effect.tapError((error) => Effect.logWarning("pi didn't clear its queue", error)),
              Effect.orElseSucceed(() => ({ steering: [], followUp: [] })),
            )

            // An open dialog holds the extension, and with it pi's run, until it's answered.
            const open = Array.from(dialogs.keys())
            dialogs.clear()
            yield* Effect.forEach(
              open,
              (id) => rpc.send({ type: "extension_ui_response", id, cancelled: true }),
              { discard: true },
            ).pipe(Effect.ignore)

            yield* rpc.request({ type: "abort" }, Schema.Unknown).pipe(
              Effect.tapError((error) => Effect.logWarning("pi didn't abort", error)),
              Effect.ignore,
              Effect.forkIn(scope),
            )

            return leftover(steers, cleared)
          }),
        }
      }),
    } satisfies AgentAdapter
  })
