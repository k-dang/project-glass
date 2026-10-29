import { NodeSocket } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { type Rpc, RpcClient, type RpcGroup, RpcSerialization } from "effect/rpc"

export const connectRpcClient = Effect.fnUntraced(function* <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  url: string,
  headers: Readonly<Record<string, string>> = {},
) {
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(NodeSocket.layerWebSocket(url, { headers })),
      Layer.provide(RpcSerialization.layerJson),
    ),
  )

  return yield* RpcClient.make(group).pipe(Effect.provideContext(protocol))
})
