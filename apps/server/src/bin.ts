import { NodeSocket } from "@effect/platform-node"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { ServerLive } from "./server"
import { ServerConfig } from "./ServerConfig"
import { runMain, wideEventsToStdoutAndOtlp } from "./wideEvents"

Layer.launch(
  ServerLive.pipe(
    Layer.provide(ServerConfig.layer),
    Layer.provide(NodeSocket.layerWebSocketConstructor),
  ),
).pipe(runMain(wideEventsToStdoutAndOtlp("backend").pipe(Layer.provide(FetchHttpClient.layer))))
