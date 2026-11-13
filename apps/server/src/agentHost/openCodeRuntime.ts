import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2/client"
import { Deferred, Effect, Schema, Scope, Stream, Option, Predicate, Semaphore } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:net"
import { launchCommand } from "../processes"
import { HostAgentError } from "./protocol"
import type { WrittenSkills } from "./sentSkills"

export const openCodeRequest = <A>(request: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: request,
    catch: () =>
      new HostAgentError({
        message:
          "OpenCode couldn't complete the request. Check its login and configuration, then retry.",
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "2 minutes",
      orElse: () =>
        Effect.fail(
          new HostAgentError({
            message: "OpenCode didn't answer. Check its process and login, then retry.",
          }),
        ),
    }),
  )

const Health = Schema.Struct({ healthy: Schema.Literal(true), version: Schema.String })

export const startOpenCode = Effect.fnUntraced(function* (
  command: string,
  folder: string,
  skills: ReadonlyArray<WrittenSkills> = [],
  transport: typeof globalThis.fetch = globalThis.fetch,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const scope = yield* Scope.Scope
  const password = randomBytes(32).toString("base64url")
  const ready = yield* Deferred.make<string, HostAgentError>()

  const failed = new HostAgentError({
    message:
      "OpenCode couldn't start. Install OpenCode 1.19.5, or set opencodeCommand in Glass's settings.json to its path and restart Glass.",
  })

  // OpenCode 1.19.5 tries 4096 for --port=0. Each owned process gets an OS-selected port.
  const port = yield* Effect.tryPromise({
    try: (signal) =>
      new Promise<number>((resolve, reject) => {
        const server = createServer()
        server.once("error", reject)
        server.listen({ host: "127.0.0.1", port: 0, signal }, () => {
          const address = server.address()
          server.close((error) => {
            if (error !== undefined) reject(error)
            else if (address !== null && !Predicate.isString(address)) resolve(address.port)
            else reject(new Error("OpenCode couldn't reserve a port"))
          })
        })
      }),
    catch: () => failed,
  })

  const inherited = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
  )(process.env["OPENCODE_CONFIG_CONTENT"] ?? "{}").pipe(
    Effect.mapError(
      () =>
        new HostAgentError({
          message: "OPENCODE_CONFIG_CONTENT must be a JSON object before Glass can start OpenCode.",
        }),
    ),
  )

  const existingSkills = Option.getOrElse(
    Schema.decodeUnknownOption(
      Schema.Struct({
        paths: Schema.optional(Schema.Array(Schema.String)),
        urls: Schema.optional(Schema.Array(Schema.String)),
      }),
    )(inherited["skills"]),
    () => ({ paths: [], urls: [] }),
  )

  const config = { ...inherited, autoupdate: false, skills: inherited["skills"] }
  const selected = skills.flatMap((pack) => pack.skills)

  if (selected.length > 0)
    config.skills = {
      paths: [...(existingSkills.paths ?? []), ...selected],
      urls: existingSkills.urls ?? [],
    }

  const child = yield* spawner
    .spawn(
      launchCommand(command, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
        cwd: folder,
        env: {
          ...process.env,
          OPENCODE_SERVER_USERNAME: "glass",
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        },
        extendEnv: true,
        forceKillAfter: "1 second",
      }),
    )
    .pipe(Effect.mapError(() => failed))

  let output = ""
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => {
      output = (output + chunk).slice(-4096)
      const url = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1]

      return url === undefined ? Effect.void : Deferred.succeed(ready, url)
    }),
    Effect.ignore,
    Effect.forkIn(scope),
  )
  // Drain both pipes without logging native output, which can contain credentials or prompts.
  yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(scope))
  yield* child.exitCode.pipe(
    Effect.andThen(Deferred.fail(ready, failed)),
    Effect.ignore,
    Effect.forkIn(scope),
  )

  const baseUrl = yield* Deferred.await(ready).pipe(
    Effect.timeoutOrElse({ duration: "2 minutes", orElse: () => Effect.fail(failed) }),
  )

  const client = createOpencodeClient({
    baseUrl,
    directory: folder,
    headers: { Authorization: `Basic ${Buffer.from(`glass:${password}`).toString("base64")}` },
    throwOnError: true,
    fetch: transport,
  })

  const health = yield* openCodeRequest((signal) => client.global.health({ signal })).pipe(
    Effect.flatMap(({ data }) => Schema.decodeUnknownEffect(Health)(data)),
    Effect.mapError(() => failed),
  )

  if (!health.version.startsWith("1."))
    return yield* new HostAgentError({
      message: `OpenCode ${health.version} uses an unsupported API. Install OpenCode 1.19.5.`,
    })

  return {
    client,
    isRunning: child.isRunning.pipe(Effect.orElseSucceed(() => false)),
    stop: child.kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" }).pipe(Effect.ignore),
    version: health.version,
  }
})

export type OpenCodeProcess = Effect.Success<ReturnType<typeof startOpenCode>>

export const openCodeRuntime = Effect.fnUntraced(function* (
  command: string,
  program: typeof startOpenCode = startOpenCode,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  // First-run migrations share a database across OpenCode processes.
  const startLock = yield* Semaphore.make(1)

  const start = (
    folder: string,
    skills: ReadonlyArray<WrittenSkills> = [],
  ): Effect.Effect<OpenCodeProcess, HostAgentError, Scope.Scope> =>
    program(command, folder, skills).pipe(
      (effect) => startLock.withPermit(effect),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    )

  return {
    start,
    open: Effect.fnUntraced(function* (folder: string, skills: ReadonlyArray<WrittenSkills>) {
      let process = yield* start(folder, skills)
      let connected = yield* Deferred.make<void>()
      const firstConnection = connected
      let attempts = 0

      const events = (options: {
        readonly sessionID: string
        readonly connected: () => Effect.Effect<void, HostAgentError>
        readonly restarted: (previous: OpenCodeProcess) => Effect.Effect<void>
      }): Stream.Stream<Event, HostAgentError> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const controller = new AbortController()
            const previous = process
            yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))

            const subscription = yield* openCodeRequest(() =>
              previous.client.event.subscribe(
                {},
                { signal: controller.signal, sseMaxRetryAttempts: 0 },
              ),
            )

            return Stream.fromAsyncIterable(
              subscription.stream,
              () =>
                new HostAgentError({
                  message: "OpenCode's event connection closed.",
                }),
            ).pipe(
              Stream.tap((event) =>
                event.type === "server.connected"
                  ? options.connected().pipe(
                      Effect.andThen(Deferred.succeed(connected, undefined)),
                      Effect.andThen(
                        Effect.sync(() => {
                          attempts = 0
                        }),
                      ),
                    )
                  : Effect.void,
              ),
              Stream.concat(
                Stream.fail(new HostAgentError({ message: "OpenCode's event connection closed." })),
              ),
            )
          }),
        ).pipe(
          Stream.catch((error) => {
            const previous = process

            return attempts++ >= 2
              ? Stream.fail(error)
              : Stream.unwrap(
                  Effect.gen(function* () {
                    if (yield* Deferred.isDone(connected)) connected = yield* Deferred.make<void>()
                    yield* Effect.sleep("500 millis")

                    if (!(yield* previous.isRunning)) {
                      process = yield* start(folder, skills)
                      yield* options.restarted(previous)
                    }

                    yield* openCodeRequest((signal) =>
                      process.client.session.get(
                        { sessionID: options.sessionID },
                        { signal, throwOnError: true },
                      ),
                    )

                    return events(options)
                  }),
                )
          }),
        )

      return {
        get current() {
          return process
        },
        connected: Effect.suspend(() => Deferred.await(connected)).pipe(
          Effect.andThen(Effect.sync(() => process)),
        ),
        ready: Deferred.await(firstConnection).pipe(
          Effect.timeoutOrElse({
            duration: "2 minutes",
            orElse: () =>
              Effect.fail(
                new HostAgentError({
                  message: "OpenCode didn't connect its event stream. Retry the Agent.",
                }),
              ),
          }),
        ),
        events,
      }
    }),
  }
})
