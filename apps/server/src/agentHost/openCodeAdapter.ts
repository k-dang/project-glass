import {
  AgentModels,
  isRequestPart,
  type AgentModel,
  RequestNotWaiting,
  type RequestPart,
  withContextOf,
} from "@glass/contracts"
import type {
  Event,
  FilePartInput,
  OpencodeClient,
  PermissionRuleset,
} from "@opencode-ai/sdk/v2/client"
import { Deferred, Effect, FileSystem, Schema, Scope, Stream, Predicate, Semaphore } from "effect"
import { createHash, randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { writeDataFile } from "../dataFiles"
import type { AgentAdapter } from "./adapter"
import type { DeliveredMessage } from "./deliveredMessage"
import {
  openCodeRequest,
  openCodeRuntime,
  startOpenCode,
  type OpenCodeProcess,
} from "./openCodeRuntime"
import { Input, machine, type History } from "./openCodeTurn"
import { type AgentRole, HostAgentError, notRunning } from "./protocol"
import { settleWith } from "./requests"
import { runTurns } from "./turnLoop"

const modelOf = (id: string) => {
  const slash = id.indexOf("/")

  return slash <= 0 ? undefined : { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) }
}

let lastMessageTime = 0

let messageCounter = 0

const messageId = () => {
  const now = Date.now()
  messageCounter = now === lastMessageTime ? messageCounter + 1 : 1
  lastMessageTime = now

  const prefix = ((BigInt(now) << 12n) + BigInt(messageCounter))
    .toString(16)
    .slice(-12)
    .padStart(12, "0")

  return `msg_${prefix}${randomBytes(7).toString("hex")}`
}

const Binding = Schema.fromJsonString(
  Schema.Struct({
    sessionID: Schema.String,
    defaultModel: Schema.NullOr(Schema.String),
    defaultVariant: Schema.NullOr(Schema.String),
    discard: Schema.Array(Schema.String),
  }),
)

const permissionRules: PermissionRuleset = [{ permission: "*", pattern: "*", action: "allow" }]

interface Delivery {
  runtime: OpenCodeProcess | undefined
  seen: boolean
  taken: boolean
  readonly ready: Deferred.Deferred<void, HostAgentError>
  readonly done: Deferred.Deferred<void>
}

interface ActiveTurn {
  readonly id: string
  readonly firstPrompt: string
  readonly deliveries: Map<string, Delivery>
  stopping: boolean
}

const sessionOf = (event: Event) => {
  if (event.type === "message.updated") return event.properties.info.sessionID

  if (event.type === "message.part.updated") return event.properties.part.sessionID

  return "sessionID" in event.properties ? event.properties.sessionID : undefined
}

const RecentModels = Schema.fromJsonString(
  Schema.Struct({
    recent: Schema.Array(Schema.Struct({ providerID: Schema.String, modelID: Schema.String })),
  }),
)

const catalog = Effect.fnUntraced(function* (client: OpencodeClient, fs: FileSystem.FileSystem) {
  const [configured, config] = yield* Effect.all([
    openCodeRequest((signal) => client.config.providers({}, { signal, throwOnError: true })),
    openCodeRequest((signal) => client.config.get({}, { signal, throwOnError: true })),
  ])

  const models = configured.data.providers.flatMap((provider) =>
    Object.values(provider.models).map((model): AgentModel => ({
      id: `${provider.id}/${model.id}`,
      name: model.name,
      efforts: Object.keys(model.variants ?? {}),
    })),
  )

  const paths = yield* openCodeRequest((signal) =>
    client.path.get({}, { signal, throwOnError: true }),
  )

  const recent = yield* fs.readFileString(join(paths.data.state, "model.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(RecentModels)),
    Effect.map(({ recent: saved }) =>
      saved.map(({ providerID, modelID }) => `${providerID}/${modelID}`),
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  )

  const first =
    configured.data.providers.find(({ id }) => id in (config.data.provider ?? {})) ??
    configured.data.providers[0]

  const defaultAgent = config.data.agent?.[config.data.default_agent ?? "build"]

  const defaultId =
    defaultAgent?.model ??
    config.data.model ??
    recent.find((id) => models.some((model) => model.id === id)) ??
    (first === undefined ? undefined : `${first.id}/${configured.data.default[first.id]}`)

  return {
    catalog: new AgentModels({
      defaultModel: models.find(({ id }) => id === defaultId) ?? null,
      models,
    }),
    variant: defaultAgent?.variant ?? null,
  }
})

export const openCodeAdapter = (command: string, program = startOpenCode) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const programs = yield* openCodeRuntime(command, program)

    return {
      models: programs.start(homedir()).pipe(
        Effect.flatMap(({ client }) => catalog(client, fs)),
        // This catalog has no repository context. A project's native default, or a
        // resumed Agent's saved default, can differ from the home-folder default.
        Effect.map(
          (result) => new AgentModels({ models: result.catalog.models, defaultModel: null }),
        ),
        Effect.scoped,
      ),
      commands: (folder, skills) =>
        programs.start(folder, skills).pipe(
          Effect.flatMap(({ client }) =>
            openCodeRequest((signal) => client.command.list({}, { signal, throwOnError: true })),
          ),
          Effect.map(({ data }) =>
            data.map(({ name, description }) => ({ name, description: description ?? "" })),
          ),
          Effect.scoped,
        ),
      start: Effect.fnUntraced(function* ({ folder, conversation, role, skills, report }) {
        if (!Predicate.isTagged(role, "Work"))
          return yield* new HostAgentError({ message: "OpenCode supports ordinary Agents only." })
        const scope = yield* Scope.Scope
        const runtime = yield* programs.open(folder, skills)

        const bindingPath = join(
          process.env["GLASS_HOME"] || homedir(),
          ".project-glass",
          "opencode",
          `${createHash("sha256").update(`${folder}\0${conversation}`).digest("hex")}.json`,
        )

        const saved = yield* fs.readFileString(bindingPath).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Binding)),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
          Effect.mapError(
            () =>
              new HostAgentError({
                message:
                  "Glass couldn't read this Agent's OpenCode session identity. Restore its session file before retrying.",
              }),
          ),
        )

        const title = `Glass ${conversation}`

        const session = yield* saved === null
          ? Effect.gen(function* () {
              const found = yield* openCodeRequest((signal) =>
                runtime.current.client.session.list(
                  { search: title, limit: 100 },
                  { signal, throwOnError: true },
                ),
              )

              const existing = found.data.filter(
                ({ metadata }) => metadata?.glassConversation === conversation,
              )

              if (existing.length > 1)
                return yield* new HostAgentError({
                  message:
                    "More than one OpenCode session belongs to this Agent. Resolve the duplicate sessions before retrying.",
                })

              if (existing[0] !== undefined) return existing[0]

              return (yield* openCodeRequest((signal) =>
                runtime.current.client.session.create(
                  { title, metadata: { glassConversation: conversation } },
                  { signal, throwOnError: true },
                ),
              )).data
            })
          : openCodeRequest((signal) =>
              runtime.current.client.session.get(
                { sessionID: saved.sessionID },
                { signal, throwOnError: true },
              ),
            ).pipe(
              Effect.map(({ data }) => data),
              Effect.mapError(
                () =>
                  new HostAgentError({
                    message:
                      "This Agent's OpenCode conversation is missing or unreachable. Restore that conversation, or start a new Agent.",
                  }),
              ),
            )

        const sessionID = session.id
        const discovered = yield* catalog(runtime.current.client, fs)
        const startingModels = discovered.catalog

        const startingModel =
          saved === null ? startingModels.defaultModel?.id : (saved.defaultModel ?? undefined)

        const startingVariant =
          (saved === null ? discovered.variant : saved.defaultVariant) ?? undefined

        const discard = new Set(saved?.discard ?? [])

        const saveBinding = () =>
          writeDataFile(
            fs,
            bindingPath,
            JSON.stringify({
              sessionID,
              defaultModel: startingModel ?? null,
              defaultVariant: startingVariant ?? null,
              discard: [...discard],
            }),
          ).pipe(
            Effect.mapError(
              () =>
                new HostAgentError({
                  message:
                    "Glass couldn't save this Agent's OpenCode session identity. Check that ~/.project-glass/opencode is writable.",
                }),
            ),
          )

        if (saved === null) yield* saveBinding()
        const nativePermissions: PermissionRuleset = []
        yield* openCodeRequest((signal) =>
          runtime.current.client.session.update(
            { sessionID, permission: nativePermissions },
            { signal, throwOnError: true },
          ),
        )

        const clearDiscarded = Effect.fnUntraced(function* () {
          if (discard.size === 0) return undefined

          for (const id of discard) {
            const result = yield* openCodeRequest((signal) =>
              runtime.current.client.session.deleteMessage(
                { sessionID, messageID: id },
                { signal, throwOnError: false },
              ),
            )

            if (
              result.response === undefined ||
              (!result.response.ok && result.response.status !== 404)
            )
              return yield* new HostAgentError({
                message:
                  "OpenCode couldn't clear an undelivered Steer. Retry before sending another message.",
              })
            discard.delete(id)
          }

          yield* saveBinding()

          return undefined
        })

        let model = startingModel === undefined ? undefined : modelOf(startingModel)
        let variant = startingVariant
        let current: ActiveTurn | null = null
        const requests = new Map<string, RequestPart>()
        const parents = new Map<string, string | undefined>([[sessionID, undefined]])

        let busy = false
        let bypass = false
        const deliveryLock = yield* Semaphore.make(1)
        const reconcileLock = yield* Semaphore.make(1)

        const belongsToAgent = Effect.fnUntraced(function* (id: string) {
          const visited = new Set<string>()
          let ancestor: string | undefined = id

          while (ancestor !== undefined && !visited.has(ancestor)) {
            if (ancestor === sessionID) return true
            visited.add(ancestor)

            if (!parents.has(ancestor)) {
              const found = yield* openCodeRequest((signal) =>
                runtime.current.client.session.get(
                  { sessionID: ancestor! },
                  { signal, throwOnError: true },
                ),
              )

              parents.set(ancestor, found.data.parentID)
            }

            ancestor = parents.get(ancestor)
          }

          return false
        })

        const ownRequests = <A extends { sessionID: string }>(values: ReadonlyArray<A>) =>
          Effect.filter(values, (request) => belongsToAgent(request.sessionID))

        const historySincePrompt = Effect.fnUntraced(function* (first: string) {
          const history: Array<History[number]> = []
          let before: string | undefined

          while (true) {
            const request: Parameters<OpencodeClient["session"]["messages"]>[0] = {
              sessionID,
              limit: 100,
            }

            if (before !== undefined) request.before = before

            const result = yield* openCodeRequest((signal) =>
              runtime.current.client.session.messages(request, { signal, throwOnError: true }),
            )

            const page = result.data

            const boundary = page.findIndex(({ info }) => info.id === first)
            history.unshift(...page.slice(Math.max(0, boundary)))
            const cursor = result.response.headers.get("x-next-cursor")

            if (cursor === null || boundary !== -1) break
            before = cursor
          }

          return history
        })

        const reconcile: (owner?: ActiveTurn | null) => Effect.Effect<void, HostAgentError> =
          Effect.fnUntraced(
            function* (owner = current) {
              if (owner === null) return

              const [history, status, permissions, questions] = yield* Effect.all([
                historySincePrompt(owner.firstPrompt),
                openCodeRequest((signal) =>
                  runtime.current.client.session.status({}, { signal, throwOnError: true }),
                ),
                openCodeRequest((signal) =>
                  runtime.current.client.permission.list({}, { signal, throwOnError: true }),
                ),
                openCodeRequest((signal) =>
                  runtime.current.client.question.list({}, { signal, throwOnError: true }),
                ),
              ])

              const ownedPermissions = yield* ownRequests(permissions.data)
              const ownedQuestions = yield* ownRequests(questions.data)

              const users = history
                .filter(({ info }) => info.role === "user")
                .map(({ info }) => info.id)

              const lastTaken = Math.max(
                -1,
                ...history.map(({ info }) =>
                  info.role === "assistant" ? users.indexOf(info.parentID) : -1,
                ),
              )

              for (const id of users.slice(0, lastTaken + 1)) {
                const delivery = owner.deliveries.get(id)

                if (delivery !== undefined) delivery.taken = true
              }

              if (current !== owner) return

              if (bypass)
                yield* Effect.forEach(
                  ownedPermissions,
                  (request) =>
                    openCodeRequest((signal) =>
                      runtime.current.client.permission.reply(
                        { requestID: request.id, reply: "once" },
                        { signal, throwOnError: true },
                      ),
                    ),
                  { discard: true },
                )
              busy =
                status.data[sessionID]?.type !== undefined &&
                status.data[sessionID]?.type !== "idle"
              yield* turns.offer(
                Input.Snapshot({
                  turnId: owner.id,
                  history,
                  delivering: [...owner.deliveries.values()].some(
                    ({ done }) => !Deferred.isDoneUnsafe(done),
                  ),
                  permissions: bypass ? [] : ownedPermissions,
                  questions: ownedQuestions,
                  busy,
                }),
              )
            },
            (effect) => reconcileLock.withPermit(effect),
          )

        const events: Stream.Stream<Input, HostAgentError> = runtime
          .events({
            sessionID,
            connected: () => reconcile(),
            restarted: (previous) =>
              Effect.suspend(() => {
                const owner = current

                return owner !== null &&
                  [...owner.deliveries.values()].some((delivery) => delivery.runtime === previous)
                  ? turns.offer(
                      Input.Failed({
                        turnId: owner.id,
                        reason:
                          "OpenCode restarted during this Turn. Its conversation was kept; send your message again.",
                      }),
                    )
                  : Effect.void
              }),
          })
          .pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                if (event.type === "session.created" || event.type === "session.updated")
                  parents.set(event.properties.info.id, event.properties.info.parentID)
              }),
            ),
            Stream.filterEffect((event) => {
              const id = sessionOf(event)

              if (id === sessionID) return Effect.succeed(true)

              if (
                !Predicate.isString(id) ||
                ![
                  "permission.asked",
                  "permission.replied",
                  "question.asked",
                  "question.replied",
                  "question.rejected",
                ].includes(event.type)
              )
                return Effect.succeed(false)

              return belongsToAgent(id)
            }),
            Stream.filterEffect((event) => {
              if (!bypass || event.type !== "permission.asked") return Effect.succeed(true)

              return openCodeRequest((signal) =>
                runtime.current.client.permission.reply(
                  { requestID: event.properties.id, reply: "once" },
                  { signal, throwOnError: true },
                ),
              ).pipe(Effect.as(false))
            }),
            Stream.tap((event) =>
              Effect.gen(function* () {
                if (event.type === "session.status") {
                  busy = event.properties.status.type !== "idle"

                  if (busy && current?.stopping)
                    yield* openCodeRequest((signal) =>
                      runtime.current.client.session.abort(
                        { sessionID },
                        { signal, throwOnError: true },
                      ),
                    ).pipe(Effect.catch(() => runtime.current.stop))

                  if (busy)
                    for (const admission of current?.deliveries.values() ?? [])
                      if (admission.seen) yield* Deferred.succeed(admission.ready, undefined)
                }

                if (event.type === "message.updated") {
                  const info = event.properties.info

                  if (info.role === "user") {
                    const admission = current?.deliveries.get(info.id)

                    if (admission !== undefined) {
                      admission.seen = true

                      if (busy) yield* Deferred.succeed(admission.ready, undefined)
                    }
                  } else {
                    const delivery = current?.deliveries.get(info.parentID)

                    if (delivery !== undefined) {
                      delivery.taken = true
                      yield* Deferred.succeed(delivery.ready, undefined)
                    }
                  }
                }

                if (event.type === "session.error" || event.type === "session.idle")
                  for (const admission of current?.deliveries.values() ?? [])
                    if (admission.seen) yield* Deferred.succeed(admission.ready, undefined)
              }),
            ),
            Stream.map((event) => Input.Native({ event })),
          )

        const turns = yield* runTurns({
          program: "OpenCode",
          machine,
          events,
          report: (event) => {
            if (Predicate.isTagged(event, "PartSet") && isRequestPart(event.part)) {
              if (event.part.status === "waiting") requests.set(event.part.requestId, event.part)
              else requests.delete(event.part.requestId)
            }

            if (Predicate.isTagged(event, "TurnEnded") && current?.id === event.turnId) {
              current = null
              requests.clear()
            }

            return report(event)
          },
          run: (): Effect.Effect<void> => {
            const owner = current

            return reconcile().pipe(
              Effect.catch(() =>
                owner === null
                  ? Effect.void
                  : turns.offer(
                      Input.Failed({
                        turnId: owner.id,
                        reason:
                          "OpenCode couldn't reconcile this Turn. Check its process, then retry.",
                      }),
                    ),
              ),
            )
          },
        })

        yield* runtime.ready

        const commands = (yield* openCodeRequest((signal) =>
          runtime.current.client.command.list({}, { signal, throwOnError: true }),
        )).data

        const send = Effect.fnUntraced(function* (
          sent: DeliveredMessage,
          id: string,
          owner: ActiveTurn,
        ) {
          const target = yield* runtime.connected

          if (current !== owner || owner.stopping) return yield* notRunning
          const delivery = owner.deliveries.get(id)

          if (delivery !== undefined) delivery.runtime = target
          yield* clearDiscarded()

          if (current !== owner || owner.stopping || runtime.current !== target)
            return yield* notRunning
          yield* turns.offer(Input.Prompt({ turnId: owner.id, messageID: id }))

          const files = sent.images.map(({ mediaType, data }): FilePartInput => ({
            type: "file",
            mime: mediaType,
            url: `data:${mediaType};base64,${data}`,
          }))

          const slash = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(sent.prompt)

          if (slash !== null && commands.some(({ name }) => name === slash[1])) {
            const request: Parameters<OpencodeClient["session"]["command"]>[0] = {
              sessionID,
              messageID: id,
              command: slash[1]!,
              arguments: slash[2] ?? "",
              parts: files,
            }

            if (model !== undefined) request.model = `${model.providerID}/${model.modelID}`

            if (variant !== undefined) request.variant = variant
            // This endpoint responds after the entire Command, not when it is admitted.
            yield* Effect.tryPromise({
              try: (signal) => {
                if (current !== owner || owner.stopping || runtime.current !== target)
                  throw new Error("This Turn no longer owns the send")

                return target.client.session.command(request, { signal, throwOnError: true })
              },
              catch: () =>
                new HostAgentError({
                  message:
                    "OpenCode couldn't execute the Command. Check its configuration, then retry.",
                }),
            })
          } else {
            const request: Parameters<OpencodeClient["session"]["prompt"]>[0] = {
              sessionID,
              messageID: id,
              parts: [{ type: "text", text: sent.prompt }, ...files],
            }

            if (model !== undefined) request.model = model

            if (variant !== undefined) request.variant = variant
            yield* Effect.tryPromise({
              try: (signal) => {
                if (current !== owner || owner.stopping || runtime.current !== target)
                  throw new Error("This Turn no longer owns the send")

                return target.client.session.prompt(request, { signal, throwOnError: true })
              },
              catch: () =>
                new HostAgentError({
                  message:
                    "OpenCode couldn't complete the message. Check its model, login and configuration, then retry.",
                }),
            })
          }

          return undefined
        })

        const deliver = Effect.fnUntraced(function* (
          sent: DeliveredMessage,
          id: string,
          owner: ActiveTurn,
        ) {
          const admitted = yield* Deferred.make<void, HostAgentError>()
          const done = yield* Deferred.make<void>()

          const delivery: Delivery = {
            seen: false,
            taken: false,
            ready: admitted,
            done,
            runtime: undefined,
          }

          owner.deliveries.set(id, delivery)
          yield* send(sent, id, owner).pipe(
            Effect.tap(() =>
              Deferred.succeed(done, undefined).pipe(
                Effect.andThen(Deferred.succeed(admitted, undefined)),
                Effect.andThen(turns.offer(Input.Delivered({ turnId: owner.id, messageID: id }))),
              ),
            ),
            Effect.tapError((error) => Deferred.fail(admitted, error)),
            Effect.catch((error) =>
              current !== owner || owner.stopping
                ? Effect.void
                : turns.offer(Input.Failed({ turnId: owner.id, reason: error.message })),
            ),
            Effect.ensuring(Deferred.succeed(done, undefined)),
            Effect.forkIn(scope),
          )

          return Deferred.await(admitted).pipe(
            Effect.timeoutOrElse({
              duration: "2 minutes",
              orElse: () =>
                (delivery.runtime?.stop ?? Effect.void).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new HostAgentError({
                        message:
                          "OpenCode didn't admit the message. Check its process and model configuration, then retry.",
                      }),
                    ),
                  ),
                ),
            }),
          )
        })

        return {
          closed: turns.closed,
          stopped: turns.stopped,
          configure: Effect.fnUntraced(function* (settings) {
            if (
              settings.permissionMode !== null &&
              settings.permissionMode !== "default" &&
              settings.permissionMode !== "bypassPermissions"
            )
              return yield* new HostAgentError({
                message: "OpenCode supports its default permission rules or bypass mode.",
              })
            const chosen = settings.model ?? startingModel
            const offered = startingModels.models.find(({ id }) => id === chosen)

            if (chosen !== undefined && offered === undefined)
              return yield* new HostAgentError({
                message:
                  "That model isn't available to OpenCode. Refresh the model list and choose again.",
              })

            if (settings.effort !== null && !(offered?.efforts ?? []).includes(settings.effort))
              return yield* new HostAgentError({
                message: "That effort isn't available for this OpenCode model.",
              })

            const nextVariant =
              settings.effort ?? (chosen === startingModel ? startingVariant : undefined)

            yield* openCodeRequest((signal) =>
              runtime.current.client.session.update(
                {
                  sessionID,
                  permission:
                    settings.permissionMode === "bypassPermissions"
                      ? permissionRules
                      : nativePermissions,
                },
                { signal, throwOnError: true },
              ),
            )

            model = chosen === undefined ? undefined : modelOf(chosen)
            variant = nextVariant
            bypass = settings.permissionMode === "bypassPermissions"

            return undefined
          }),
          startTurn: Effect.fnUntraced(function* (turnId, sent) {
            yield* turns.begin(turnId, withContextOf(sent))

            const owner: ActiveTurn = {
              id: turnId,
              firstPrompt: messageId(),
              deliveries: new Map(),
              stopping: false,
            }

            current = owner
            const admitted = yield* deliver(sent, owner.firstPrompt, owner)
            yield* admitted.pipe(
              Effect.catch((error) =>
                turns.offer(
                  Input.Failed({
                    turnId,
                    reason: error.message,
                  }),
                ),
              ),
              Effect.forkIn(scope),
            )
          }),
          steer: Effect.fnUntraced(
            function* (sent) {
              const id = messageId()

              const owner = current

              if (owner === null || owner.stopping || !(yield* turns.steer({ ...sent, id })))
                return yield* notRunning
              const admitted = yield* deliver(sent, id, owner)
              yield* admitted.pipe(
                Effect.tapError(() => Effect.sync(() => owner.deliveries.delete(id))),
                Effect.onError(() =>
                  turns.dropSteer(id).pipe(Effect.andThen(reconcile()), Effect.ignore),
                ),
              )

              return undefined
            },
            (effect) => deliveryLock.withPermit(effect),
          ),
          answer: Effect.fnUntraced(function* (requestId, answer) {
            const waiting = requests.get(requestId)

            if (waiting === undefined) return yield* new RequestNotWaiting()
            const settled = yield* settleWith(waiting, answer)

            if (Predicate.isTagged(settled, "PermissionRequest")) {
              const request: Parameters<OpencodeClient["permission"]["reply"]>[0] = {
                requestID: requestId,
                reply: settled.status === "allowed" ? "once" : "reject",
              }

              if (settled.reason !== null) request.message = settled.reason
              yield* openCodeRequest((signal) =>
                runtime.current.client.permission.reply(request, { signal, throwOnError: true }),
              )
            } else
              yield* openCodeRequest((signal) =>
                runtime.current.client.question.reply(
                  {
                    requestID: requestId,
                    answers: (settled.answers ?? []).map(({ chosen, text }) => [
                      ...chosen,
                      ...(text === null ? [] : [text]),
                    ]),
                  },
                  { signal, throwOnError: true },
                ),
              )
            yield* turns.offer(Input.Answered({ requestId, answer }))

            return undefined
          }),
          stopTurn: Effect.gen(function* () {
            const owner = current
            const stoppingRuntime = runtime.current
            const steers = yield* turns.stop

            if (steers === null || owner === null) return null
            owner.stopping = true
            // Fence both admission and completion. A Steer can start a new native
            // loop just as an earlier one ends; the event reader aborts late starts too.
            const sending = [...owner.deliveries.values()]
            yield* Effect.forEach(
              sending,
              ({ ready: admission }) => Deferred.await(admission).pipe(Effect.ignore),
              { discard: true },
            ).pipe(
              Effect.timeoutOrElse({ duration: "2 minutes", orElse: () => stoppingRuntime.stop }),
            )
            yield* openCodeRequest((signal) =>
              stoppingRuntime.client.session.abort({ sessionID }, { signal, throwOnError: true }),
            ).pipe(Effect.catch(() => stoppingRuntime.stop))
            yield* Effect.forEach(sending, ({ done }) => Deferred.await(done), {
              discard: true,
            }).pipe(
              Effect.timeoutOrElse({ duration: "2 minutes", orElse: () => stoppingRuntime.stop }),
            )
            yield* reconcile(owner).pipe(Effect.ignore)
            const leftover = steers.filter(({ id }) => !owner.deliveries.get(id)?.taken)

            for (const steer of leftover) discard.add(steer.id)

            if (discard.size > 0) yield* saveBinding().pipe(Effect.ignore)
            yield* clearDiscarded().pipe(Effect.ignore)
            yield* turns.offer(Input.Stopped({ turnId: owner.id }))

            return leftover.map(withContextOf)
          }).pipe((effect) => deliveryLock.withPermit(effect)),
        }
      }),
    } satisfies AgentAdapter<AgentRole>
  })
