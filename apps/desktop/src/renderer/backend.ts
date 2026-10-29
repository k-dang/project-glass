import { RegistryContext } from "@effect/atom-react"
import { type DesktopBridge, type GlassRpcError, GlassRpcs, TOKEN_PARAM } from "@glass/contracts"
import { Context, Effect, type Exit, Layer } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { useContext, useMemo } from "react"

declare global {
  interface Window {
    readonly glass: DesktopBridge
  }
}

const rpcUrl = Effect.promise(() => window.glass.backendEndpoint()).pipe(
  Effect.map((endpoint) => {
    const url = new URL(endpoint.url)
    url.searchParams.set(TOKEN_PARAM, endpoint.token)

    return url.toString()
  }),
)

export type BackendError = GlassRpcError | RpcClientError.RpcClientError

export const backendReachableAtom = Atom.make(true).pipe(Atom.keepAlive)

const connectionHooks = Layer.effect(
  RpcClient.ConnectionHooks,
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry

    return {
      onConnect: Effect.sync(() => registry.set(backendReachableAtom, true)),
      onDisconnect: Effect.sync(() => registry.set(backendReachableAtom, false)),
    }
  }),
)

export class Backend extends Context.Service<
  Backend,
  RpcClient.FromGroup<typeof GlassRpcs, RpcClientError.RpcClientError>
>()("@glass/desktop/renderer/Backend") {
  static readonly layer = Layer.effect(Backend, RpcClient.make(GlassRpcs)).pipe(
    Layer.provide(
      RpcClient.layerProtocolSocket({
        retryTransientErrors: true,
        // Effect defaults both ping interval and timeout to 5s; timer drift can cause timeouts.
        pingTimeout: "15 seconds",
      }).pipe(Layer.provide(connectionHooks)),
    ),
    Layer.provide(Socket.layerWebSocket(rpcUrl)),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(RpcSerialization.layerJson),
  )
}

export const backendLayerAtom = Atom.make<Layer.Layer<Backend, never, AtomRegistry.AtomRegistry>>(
  Backend.layer,
).pipe(Atom.keepAlive)

export const backendRuntime = Atom.runtime((get) => get(backendLayerAtom)).pipe(Atom.keepAlive)

export interface BackendRuntime {
  readonly runPromiseExit: <A, E>(
    effect: Effect.Effect<A, E, Backend>,
    options?: Effect.RunOptions,
  ) => Promise<Exit.Exit<A, E>>
}

export const backendRuntimeOf = (registry: AtomRegistry.AtomRegistry): BackendRuntime => ({
  runPromiseExit: (effect, options) =>
    Effect.runPromiseExit(
      AtomRegistry.getResult(registry, backendRuntime).pipe(
        Effect.flatMap((context) => Effect.provideContext(effect, context)),
      ),
      options,
    ),
})

export const useBackendRuntime = () => {
  const registry = useContext(RegistryContext)

  return useMemo(() => backendRuntimeOf(registry), [registry])
}
