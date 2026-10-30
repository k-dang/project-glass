import { NodeRuntime, NodeSocket } from "@effect/platform-node"
import { Layer } from "effect"
import { ServerLive } from "./server"
import { ServerConfig } from "./ServerConfig"

Layer.launch(
  ServerLive.pipe(
    Layer.provide(ServerConfig.layer),
    Layer.provide(NodeSocket.layerWebSocketConstructor),
  ),
).pipe(NodeRuntime.runMain)
