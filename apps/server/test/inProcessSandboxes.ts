import type { AgentEngine, SandboxProvider, SandboxState } from "@glass/plugin"
import { Context, Deferred, Effect, Exit, Layer, Redacted, Schema, Scope } from "effect"
import { NodeHttpServer } from "@effect/platform-node"
import { HttpServer } from "effect/http"
import { createServer } from "node:http"
import type { Socket } from "node:net"
import type { Changes } from "../src/agentHost/Changes"
import type { HostAgents } from "../src/agentHost/HostAgents"
import type { Journal } from "../src/agentHost/Journal"
import { hostServer } from "../src/agentHost/server"
import { MissingLogin, NoCapacity } from "../src/sandboxFailures"

export interface InProcessSandboxSettings {
  readonly engines?: readonly [AgentEngine, ...Array<AgentEngine>]
  /** Keeps `create` at this step until settings name another. */
  readonly holdAt?: string
  readonly failAt?: string
  readonly missingLogin?: { readonly login: string; readonly fix: string }
  readonly noCapacity?: string
}

export const steps = ["Creating the Sandbox", "Starting the agent"] as const

const SandboxId = Schema.Struct({ agentId: Schema.String })

const agentIdOf = (state: SandboxState) => Schema.decodeUnknownSync(SandboxId)(state).agentId

/**
 * A Sandbox provider whose Sandboxes are agent hosts in this process, each built with the services
 * `host` makes, reached over HTTP like any Sandbox's.
 */
export const inProcessSandboxes = (host: () => Layer.Layer<HostAgents | Journal | Changes>) => {
  let settings: InProcessSandboxSettings = {}

  const waiting: Array<() => void> = []
  const urls = new Map<string, string>()

  const hosts = new Map<
    string,
    { readonly scope: Scope.Closeable; readonly sockets: ReadonlySet<Socket> }
  >()

  const shutDowns = new Map<string, Deferred.Deferred<void>>()
  const events: Array<string> = []

  const noteEnded = (agentId: string) => {
    if (!events.includes(`ended ${agentId}`)) events.push(`ended ${agentId}`)
  }

  const refuseLogin = () => {
    if (settings.missingLogin !== undefined)
      throw new MissingLogin(settings.missingLogin.login, settings.missingLogin.fix)
  }

  const passed = (step: string, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason)

      signal.addEventListener("abort", () => reject(signal.reason), { once: true })

      const check = () => {
        if (settings.holdAt === step) waiting.push(check)
        else resolve()
      }

      check()
    })

  const stop = (agentId: string) =>
    Effect.suspend(() => {
      const running = hosts.get(agentId)
      hosts.delete(agentId)

      if (running === undefined) return Effect.void

      for (const socket of running.sockets) socket.destroy()

      return Scope.close(running.scope, Exit.void)
    })

  const startHost = async (agentId: string, token: string) => {
    const scope = Scope.makeUnsafe()
    const shutDown = Deferred.makeUnsafe<void>()
    const server = createServer()
    const sockets = new Set<Socket>()

    server.on("connection", (socket) => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
    })

    const context = await Effect.runPromise(
      Layer.buildWithScope(
        hostServer({ token: Redacted.make(token), shutDown }).pipe(
          Layer.provideMerge(NodeHttpServer.layer(() => server, { port: 0, host: "127.0.0.1" })),
          Layer.provide(host()),
        ),
        scope,
      ),
    )

    hosts.set(agentId, { scope, sockets })
    shutDowns.set(agentId, shutDown)
    urls.set(agentId, HttpServer.formatAddress(Context.get(context, HttpServer.HttpServer).address))

    Effect.runFork(
      Deferred.await(shutDown).pipe(
        Effect.andThen(Effect.sync(() => noteEnded(agentId))),
        Effect.andThen(stop(agentId)),
      ),
    )
  }

  const provider: SandboxProvider = {
    name: "Fake Sandboxes",
    get engines() {
      return settings.engines ?? ["claude-code", "pi"]
    },
    create: async (request, { progress, record, signal }) => {
      refuseLogin()

      if (settings.noCapacity !== undefined) throw new NoCapacity(settings.noCapacity)

      record({ agentId: request.agentId })

      for (const step of steps) {
        progress(step)
        await passed(step, signal)

        if (settings.failAt === step) throw new Error(`The fake Sandbox failed at ${step}`)
      }

      await startHost(request.agentId, request.host.environment["GLASS_HOST_TOKEN"] ?? "")
    },
    target: async (state) => {
      const url = urls.get(agentIdOf(state))

      if (url === undefined) throw new Error("No such fake Sandbox")

      return { url, headers: {} }
    },
    remove: async (state) => {
      refuseLogin()

      const agentId = agentIdOf(state)
      const shutDown = shutDowns.get(agentId)

      if (shutDown !== undefined && Deferred.isDoneUnsafe(shutDown)) noteEnded(agentId)

      await Effect.runPromise(stop(agentId))
      urls.delete(agentId)
      events.push(`removed ${agentId}`)
    },
    models: async () => ({ defaultModel: null, models: [] }),
  }

  return {
    provider,
    /** What happened to the Sandboxes, in order: `ended <agentId>` and `removed <agentId>`. */
    events,
    configure: (next: InProcessSandboxSettings) => {
      settings = next

      for (const check of waiting.splice(0)) check()
    },
    /** Ends a Sandbox's agent host as a crash would, leaving the Sandbox. */
    stopHost: stop,
    closeAll: Effect.suspend(() => Effect.forEach([...hosts.keys()], stop, { discard: true })),
  }
}
