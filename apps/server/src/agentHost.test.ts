import { NodeSocket } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { RPC_PATH } from "@glass/contracts"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { HOST_TOKEN_HEADER } from "./agentHost/hostAddress"
import { AgentHostRpcs, hostPort } from "./agentHost/protocol"
import { isolatedHome } from "../test/harness"
import { bundledEntry } from "./processes"
import { connectRpcClient } from "./rpcSocket"

const TOKEN = "host-token"

const startPortedHost = (env: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const host = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, [bundledEntry("agentHost", import.meta.url)], {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            GLASS_HOST_TOKEN: TOKEN,
            GLASS_HOST_PORT: "0",
            ...env,
          },
          stdio: ["ignore", "ignore", "inherit", "pipe"],
        }),
      ),
      (child) => Effect.sync(() => child.kill()),
    )

    return yield* Effect.promise(() => hostPort(host))
  })

it.live("takes its token only from a header, so it never sits in a URL", () =>
  Effect.gen(function* () {
    const port = yield* startPortedHost()

    const status = (path: string, headers: Record<string, string> = {}) =>
      Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}${path}`, { headers }).then((response) => response.status),
      )

    assert.strictEqual(yield* status(`${RPC_PATH}?token=${TOKEN}`), 401)
    assert.strictEqual(yield* status(RPC_PATH, { [HOST_TOKEN_HEADER]: "wrong" }), 401)
    assert.notStrictEqual(yield* status(RPC_PATH, { [HOST_TOKEN_HEADER]: TOKEN }), 401)
  }).pipe(Effect.scoped),
)

it.live("starts agents without the variables Glass gave it, or any it inherited", () =>
  Effect.gen(function* () {
    const folder = yield* isolatedHome
    const seen = join(folder, "names.json")
    const pi = join(folder, "pi.mjs")

    writeFileSync(
      pi,
      `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(seen)}, JSON.stringify(Object.keys(process.env)))\n`,
    )

    const port = yield* startPortedHost({
      GLASS_HOST_RECORD: join(folder, "agent-host.json"),
      GLASS_PI_COMMAND: pi,
      GLASS_TOKEN: "launch-token",
    })

    const client = yield* connectRpcClient(AgentHostRpcs, `ws://127.0.0.1:${port}${RPC_PATH}`, {
      [HOST_TOKEN_HEADER]: TOKEN,
    })

    yield* client.ListModels({ harness: "pi" }).pipe(Effect.ignore)

    const names: ReadonlyArray<string> = JSON.parse(readFileSync(seen, "utf8"))
    assert.deepStrictEqual(
      [
        "GLASS_HOST_TOKEN",
        "GLASS_HOST_PORT",
        "GLASS_HOST_RECORD",
        "GLASS_PI_COMMAND",
        "GLASS_TOKEN",
      ].filter((name) => names.includes(name)),
      [],
    )
    assert.include(
      names.map((name) => name.toUpperCase()),
      "PATH",
    )
  }).pipe(Effect.scoped, Effect.provide(NodeSocket.layerWebSocketConstructor)),
)
