import { NodeSocket } from "@effect/platform-node"
import { GlassRpcs, RPC_PATH, TOKEN_PARAM } from "@glass/contracts"
import { ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { HttpServer } from "effect/http"
import { Socket } from "effect/socket"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, vi } from "vite-plus/test"
import { connectRpcClient } from "../src/rpcSocket"
import { ServerLive } from "../src/server"
import { ServerConfig } from "../src/ServerConfig"
import { startFakeGitHub } from "./fakeGitHub"
import { VIEWER } from "./fakePullRequest"

export const LAUNCH_TOKEN = "test-launch-token"

export const RENDERER_ORIGIN = "glass://app"

export const isolatedHome = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "glass-test-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
)

afterEach(() => vi.unstubAllEnvs())

export const startBackend = Effect.fnUntraced(function* (
  env: Record<string, string>,
  homeDirectory?: string,
) {
  const webSocketConstructor = yield* Effect.serviceOption(Socket.WebSocketConstructor).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Socket.WebSocketConstructor.pipe(Effect.provide(NodeSocket.layerWebSocketConstructor)),
        onSome: Effect.succeed,
      }),
    ),
  )

  const home = homeDirectory ?? (yield* isolatedHome)
  vi.stubEnv("HOME", home)
  vi.stubEnv("USERPROFILE", home)
  vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".pi", "agent"))

  const github =
    "GLASS_GITHUB_API_URL" in env
      ? {}
      : { GH_TOKEN: VIEWER.token, GLASS_GITHUB_API_URL: (yield* startFakeGitHub()).url }

  const services = yield* Layer.build(
    ServerLive.pipe(
      Layer.provide(ServerConfig.layer),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnvRecord({
            GLASS_PORT: "0",
            GLASS_TOKEN: LAUNCH_TOKEN,
            GLASS_ALLOWED_ORIGINS: RENDERER_ORIGIN,
            GLASS_HOME: home,
            // A test that forgets these fails fast instead of reaching github.com or your installed agents.
            GLASS_GIT_REMOTE: join(home, "no-git-remote"),
            GLASS_CLAUDE_COMMAND: "glass-missing-claude",
            GLASS_PI_COMMAND: "glass-missing-pi",
            ...github,
            ...env,
          }),
        ),
      ),
    ),
  ).pipe(Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor))

  const baseUrl = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address)

  const rpcUrl = `${baseUrl.replace(/^http/, "ws")}${RPC_PATH}?${TOKEN_PARAM}=${LAUNCH_TOKEN}`

  const client = yield* connectRpcClient(GlassRpcs, rpcUrl).pipe(
    Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
  )

  // Effect closes a still-connecting WebSocket after dropping its error listener, which `ws` then
  // throws as an uncaught exception; a test that never calls the client would end that way.
  yield* client.ListSandboxProviders()

  return { baseUrl, client }
})

export const startSignedInBackend = Effect.gen(function* () {
  const github = yield* startFakeGitHub()

  const { client } = yield* startBackend({
    GH_TOKEN: VIEWER.token,
    GLASS_GITHUB_API_URL: github.url,
  })

  return { github, client }
})
