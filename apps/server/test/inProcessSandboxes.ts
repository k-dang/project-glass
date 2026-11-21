import type { AgentHarness, SandboxProvider, SandboxState } from "@glass/plugin"
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Schema,
  Scope,
} from "effect"
import { NodeHttpServer } from "@effect/platform-node"
import { HttpRouter, HttpServer } from "effect/http"
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"
import { RPC_PATH } from "@glass/contracts"
import { createServer } from "node:http"
import type { Socket } from "node:net"
import type { Changes } from "../src/Changes"
import type { FolderFiles } from "../src/agentHost/FolderFiles"
import type { HostThreads } from "../src/agentHost/HostThreads"
import type { HostGlassTools } from "../src/agentHost/HostGlassTools"
import type { Journal } from "../src/agentHost/Journal"
import { Hello } from "../src/agentHost/protocol"
import { hostServer } from "../src/agentHost/server"
import { MissingLogin, NoCapacity, SandboxGone } from "../src/sandboxFailures"

export type ProviderCall = "target" | "extend" | "remove" | "models"

export interface InProcessSandboxSettings {
  readonly harnesses?: readonly [AgentHarness, ...Array<AgentHarness>]
  readonly holdAt?: string
  readonly failAt?: string
  readonly missingLogin?: { readonly login: string; readonly fix: string }
  readonly noCapacity?: string
  readonly extensionMillis?: number
  readonly maxLifetimeMillis?: number
  readonly stall?: ProviderCall
}

const TWO_DAYS = Duration.toMillis(Duration.days(2))

export const steps = ["Creating the Sandbox", "Starting the agent"] as const

const SandboxId = Schema.Struct({ threadId: Schema.String })

const threadIdOf = (state: SandboxState) => Schema.decodeUnknownSync(SandboxId)(state).threadId

const VersionedHost = RpcGroup.make(Hello)

const UnversionedHost = RpcGroup.make(Rpc.make("Acknowledge"))

const serveRpcs = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  handlers: Layer.Layer<Rpc.ToHandler<Rpcs>>,
) =>
  HttpRouter.serve(RpcServer.layerHttp({ group, path: RPC_PATH, protocol: "websocket" }), {
    disableLogger: true,
    disableListenLog: true,
  }).pipe(Layer.provide(handlers), Layer.provide(RpcSerialization.layerJson))

export type HostKind =
  | { readonly kind: "current" }
  | { readonly kind: "unversioned" }
  | { readonly kind: "versioned"; readonly protocol: number }

const current: HostKind = { kind: "current" }

const otherHost = (kind: Exclude<HostKind, { readonly kind: "current" }>) =>
  kind.kind === "unversioned"
    ? serveRpcs(UnversionedHost, UnversionedHost.toLayer({ Acknowledge: () => Effect.void }))
    : serveRpcs(
        VersionedHost,
        VersionedHost.toLayer({
          Hello: () => Effect.succeed({ host: "other", protocol: kind.protocol }),
        }),
      )

export const inProcessSandboxes = Effect.fnUntraced(function* (
  host: () => Layer.Layer<HostThreads | HostGlassTools | Journal | Changes | FolderFiles>,
) {
  const clock = yield* Clock.Clock
  const context = yield* Effect.context()
  const runPromise = Effect.runPromiseWith(context)
  const runFork = Effect.runForkWith(context)
  let settings: InProcessSandboxSettings = {}

  const waiting: Array<() => void> = []
  const urls = new Map<string, string>()
  const gone = new Set<string>()
  const createdAt = new Map<string, number>()
  const expiries = new Map<string, Fiber.Fiber<void>>()

  const hosts = new Map<
    string,
    {
      readonly scope: Scope.Closeable
      readonly sockets: ReadonlySet<Socket>
      readonly token: string
    }
  >()

  const shutDowns = new Map<string, Deferred.Deferred<void>>()
  const events: Array<string> = []

  const noteEnded = (threadId: string) => {
    if (!events.includes(`ended ${threadId}`)) events.push(`ended ${threadId}`)
  }

  const refuseLogin = () => {
    if (settings.missingLogin !== undefined)
      throw new MissingLogin(settings.missingLogin.login, settings.missingLogin.fix)
  }

  const held = (holding: () => boolean, signal: AbortSignal, onAbort = () => {}) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason)

      signal.addEventListener(
        "abort",
        () => {
          onAbort()
          reject(signal.reason)
        },
        { once: true },
      )

      const check = () => {
        if (signal.aborted) return

        if (holding()) waiting.push(check)
        else resolve()
      }

      check()
    })

  const passed = (step: string, signal: AbortSignal) => held(() => settings.holdAt === step, signal)

  const answered = (call: ProviderCall, signal: AbortSignal) =>
    held(
      () => settings.stall === call,
      signal,
      () => events.push(`abandoned ${call}`),
    )

  const stop = (threadId: string) =>
    Effect.suspend(() => {
      const running = hosts.get(threadId)
      hosts.delete(threadId)

      if (running === undefined) return Effect.void

      for (const socket of running.sockets) socket.destroy()

      return Scope.close(running.scope, Exit.void)
    })

  const startHost = async (threadId: string, token: string, kind: HostKind) => {
    const scope = Scope.makeUnsafe()
    const shutDown = Deferred.makeUnsafe<void>()
    const server = createServer()
    const sockets = new Set<Socket>()

    server.on("connection", (socket) => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
    })

    const services = await runPromise(
      Layer.buildWithScope(
        (kind.kind === "current"
          ? hostServer({ token: Redacted.make(token), shutDown }).pipe(Layer.provide(host()))
          : otherHost(kind)
        ).pipe(
          Layer.provideMerge(NodeHttpServer.layer(() => server, { port: 0, host: "127.0.0.1" })),
        ),
        scope,
      ),
    )

    hosts.set(threadId, { scope, sockets, token })
    shutDowns.set(threadId, shutDown)
    urls.set(
      threadId,
      HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address),
    )

    runFork(
      Deferred.await(shutDown).pipe(
        Effect.andThen(Effect.sync(() => noteEnded(threadId))),
        Effect.andThen(stop(threadId)),
      ),
    )
  }

  const provider: SandboxProvider = {
    name: "Fake Sandboxes",
    get harnesses() {
      return settings.harnesses ?? ["claude-code", "pi"]
    },
    create: async (request, { progress, record, signal }) => {
      refuseLogin()

      if (settings.noCapacity !== undefined) throw new NoCapacity(settings.noCapacity)

      record({ threadId: request.threadId })
      createdAt.set(request.threadId, clock.currentTimeMillisUnsafe())

      for (const step of steps) {
        progress(step)
        await passed(step, signal)

        if (settings.failAt === step) throw new Error(`The fake Sandbox failed at ${step}`)
      }

      await startHost(request.threadId, request.host.environment["GLASS_HOST_TOKEN"] ?? "", current)
    },
    target: async (state, signal) => {
      await answered("target", signal)
      const threadId = threadIdOf(state)

      if (gone.has(threadId)) throw new SandboxGone()

      const url = urls.get(threadId)

      if (url === undefined) throw new Error("No such fake Sandbox")

      return { url, headers: {} }
    },
    extend: async (state, signal) => {
      await answered("extend", signal)
      const threadId = threadIdOf(state)

      if (gone.has(threadId)) throw new SandboxGone()

      const expiresAt = Math.min(
        clock.currentTimeMillisUnsafe() + (settings.extensionMillis ?? TWO_DAYS),
        (createdAt.get(threadId) ?? clock.currentTimeMillisUnsafe()) +
          (settings.maxLifetimeMillis ?? TWO_DAYS),
      )

      reclaimAt(threadId, expiresAt)

      return new Date(expiresAt)
    },
    remove: async (state, signal) => {
      await answered("remove", signal)
      refuseLogin()

      const threadId = threadIdOf(state)
      const shutDown = shutDowns.get(threadId)

      if (shutDown !== undefined && Deferred.isDoneUnsafe(shutDown)) noteEnded(threadId)

      await runPromise(stop(threadId))
      urls.delete(threadId)
      events.push(`removed ${threadId}`)
    },
    models: async (_harness, signal) => {
      await answered("models", signal)

      return { defaultModel: null, models: [] }
    },
  }

  const reclaim = (threadId: string) =>
    stop(threadId).pipe(
      Effect.andThen(
        Effect.sync(() => {
          expiries.get(threadId)?.interruptUnsafe()
          expiries.delete(threadId)
          gone.add(threadId)
        }),
      ),
    )

  const reclaimAt = (threadId: string, expiresAt: number) => {
    expiries.get(threadId)?.interruptUnsafe()
    expiries.set(
      threadId,
      runFork(
        clock.sleep(Duration.millis(expiresAt - clock.currentTimeMillisUnsafe())).pipe(
          Effect.andThen(() => {
            expiries.delete(threadId)

            return reclaim(threadId)
          }),
        ),
      ),
    )
  }

  return {
    provider,
    events,
    configure: (next: InProcessSandboxSettings) => {
      settings = next

      for (const check of waiting.splice(0)) check()
    },
    stopHost: stop,
    dropConnections: (threadId: string) =>
      Effect.sync(() => {
        for (const socket of hosts.get(threadId)?.sockets ?? []) socket.destroy()
      }),
    restartHost: (threadId: string, kind: HostKind = current) =>
      Effect.suspend(() => {
        const running = hosts.get(threadId)

        if (running === undefined) return Effect.die(`No running host for ${threadId}`)

        return stop(threadId).pipe(
          Effect.andThen(Effect.promise(() => startHost(threadId, running.token, kind))),
        )
      }),
    reclaim,
    setGone: (threadId: string, isGone: boolean) => {
      if (isGone) gone.add(threadId)
      else gone.delete(threadId)
    },
    closeAll: Effect.suspend(() => {
      return Effect.forEach(expiries.values(), Fiber.interrupt, { discard: true }).pipe(
        Effect.andThen(Effect.forEach([...hosts.keys()], stop, { discard: true })),
      )
    }),
  }
})
