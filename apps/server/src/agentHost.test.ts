import { assert, it } from "@effect/vitest"
import { RPC_PATH } from "@glass/contracts"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { HOST_TOKEN_HEADER } from "./agentHost/protocol"
import { hostPort } from "../test/ports"
import { bundledEntry } from "./processes"

const TOKEN = "host-token"

const startPortedHost = Effect.gen(function* () {
  const host = yield* Effect.acquireRelease(
    Effect.sync(() =>
      spawn(process.execPath, [bundledEntry("agentHost", import.meta.url)], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          GLASS_HOST_TOKEN: TOKEN,
          GLASS_HOST_PORT: "0",
        },
        stdio: ["ignore", "ignore", "inherit", "pipe"],
      }),
    ),
    (child) => Effect.sync(() => child.kill()),
  )

  const port = yield* Effect.promise(() => hostPort(host))

  const status = (path: string, headers: Record<string, string> = {}) =>
    Effect.promise(() =>
      fetch(`http://127.0.0.1:${port}${path}`, { headers }).then((response) => response.status),
    )

  return status
})

it.live("takes its token only from a header, so it never sits in a URL", () =>
  Effect.gen(function* () {
    const status = yield* startPortedHost

    assert.strictEqual(yield* status(`${RPC_PATH}?token=${TOKEN}`), 401)
    assert.strictEqual(yield* status(RPC_PATH, { [HOST_TOKEN_HEADER]: "wrong" }), 401)
  }).pipe(Effect.scoped),
)
