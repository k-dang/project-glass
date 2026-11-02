import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import { RuleTester } from "vite-plus/lint/plugins-dev"
import { architecture } from "./architecture.ts"
import { root } from "./paths.ts"
import { testWaits } from "./test-waits.ts"

RuleTester.describe = describe

RuleTester.it = it

const tester = new RuleTester()

const renderer = join(root, "apps/desktop/src/renderer/App.tsx")

const backend = join(root, "apps/server/src/ToDos.ts")

const contracts = join(root, "packages/contracts/src/index.ts")

const testFile = join(root, "apps/server/src/Tours.test.ts")

tester.run("architecture", architecture, {
  valid: [
    { filename: renderer, code: 'import { Agent } from "@glass/contracts"' },
    { filename: renderer, code: 'import type { Desktop } from "@glass/contracts/desktop"' },
    { filename: renderer, code: 'import { App } from "@/App"' },
    { filename: backend, code: 'import { ToDo } from "@glass/contracts"' },
    { filename: backend, code: 'import type { RpcClient } from "effect/rpc"' },
    { filename: backend, code: 'import { type RpcClient, RpcClientError } from "effect/rpc"' },
    { filename: backend, code: 'import { HttpClientError } from "effect/http"' },
    { filename: backend, code: 'import { HttpClientError } from "effect/http/HttpClientError"' },
    { filename: backend, code: 'import { NodeServices } from "@effect/platform-node"' },
    { filename: backend, code: 'export { NodeServices } from "@effect/platform-node"' },
    { filename: backend, code: 'export { RpcClientError } from "effect/rpc"' },
    { filename: backend, code: 'import { HostAgentError } from "./agentHost/protocol"' },
    { filename: backend, code: 'import { LocalAgentHost } from "./LocalAgentHost"' },
    { filename: backend, code: 'import { call } from "./sandboxCalls"' },
    { filename: backend, code: 'import { readFile } from "node:fs/promises"' },
    { filename: contracts, code: 'import { Rpc, RpcGroup } from "effect/rpc"' },
    ...[
      "server.ts",
      "handlers.ts",
      "bin.ts",
      "access.ts",
      "agentHost.ts",
      "agentHost/handlers.ts",
      "LocalAgentHost.ts",
      "rpcSocket.ts",
      "sandboxCalls.ts",
    ].map((file) => ({
      filename: join(root, "apps/server/src", file),
      code: 'import { RpcServer } from "effect/rpc"; import { HttpRouter } from "effect/http"',
    })),
    {
      filename: join(root, "apps/server/src/github/GitHubClient.ts"),
      code: 'import { FetchHttpClient, HttpClient } from "effect/http"',
    },
    {
      filename: join(root, "apps/server/src/agentHost/protocol.ts"),
      code: 'import { Rpc, RpcGroup } from "effect/rpc"',
    },
    {
      filename: join(root, "apps/desktop/e2e/glass.ts"),
      code: 'import { startFakeGitHub } from "../../server/test/fakeGitHub"; import type { TourAnswer } from "../../server/src/tourPrompt"',
    },
    {
      filename: join(root, "apps/desktop/src/renderer/App.test.tsx"),
      code: 'import { startFakeGitHub } from "../../../../server/test/fakeGitHub"',
    },
    { filename: renderer, code: 'function f(require) { return require("node:fs") }' },
  ],
  invalid: [
    ...(process.platform === "win32"
      ? ['import "../../../SERVER/src/server"', 'import "@/../MAIN/index"'].map((code) => ({
          filename: renderer,
          code,
          errors: [{ messageId: "renderer" }],
        }))
      : []),
    ...[
      'import { ServerLive } from "../../../server/src/server"',
      'import type { ServerLive } from "../../../server/src/server.js"',
      'export * from "../../../server/src/server"',
      'export { ServerLive } from "../../../server/src/server"',
      'const backend = import("../../../server/src/server")',
      "const backend = import(`../../../server/src/server`)",
      'type Backend = import("../../../server/src/server")',
      'const backend = require("../../../server/src/server")',
      'import backend = require("../../../server/src/server")',
      'import { ServerLive } from "@/../../../server/src/server"',
      'import { ServerLive } from "@/../main/../../../server/src/server"',
      'import "../main/index"',
      'import "@/../preload/index"',
      'import "@/../../test/testBackend"',
      'import "node:fs"',
      'import "fs/promises"',
      'import type { Buffer } from "node:buffer"',
      'import "electron"',
    ].map((code) => ({ filename: renderer, code, errors: [{ messageId: "renderer" }] })),
    ...[
      'import "../../../apps/server/src/ToDos"',
      'export * from "../../../apps/desktop/src/main/index"',
      'import "../../../apps/server/test/harness"',
    ].map((code) => ({ filename: contracts, code, errors: [{ messageId: "contracts" }] })),
    ...[
      'import { GlassRpcHandlers } from "./handlers"',
      'import type { ServerLive } from "./server"',
      'import { connectRpcClient } from "./rpcSocket"',
      'export * from "./agentHost/handlers"',
      'import { RpcServer } from "effect/rpc"',
      'import { RpcClient as Client } from "effect/rpc"',
      'import * as Rpc from "effect/rpc"',
      'import * as Http from "effect/http"',
      'import { HttpServerRequest } from "effect/http"',
      'import { RpcClient } from "effect/rpc/RpcClient"',
      'import { HttpRouter } from "effect/http/HttpRouter"',
      'import { NodeHttpServer } from "@effect/platform-node"',
      'import { NodeHttpServer as Server } from "@effect/platform-node/NodeHttpServer"',
      'import { createServer } from "node:http"',
      'import { request } from "https"',
    ].map((code) => ({ filename: backend, code, errors: [{ messageId: "transport" }] })),
    {
      filename: join(root, "apps/server/src/agentHost/HostAgents.ts"),
      code: 'import { AgentHostHandlers } from "./handlers"',
      errors: [{ messageId: "transport" }],
    },
    {
      filename: join(root, "apps/server/src/github/GitHubClient.ts"),
      code: 'import { HttpRouter } from "effect/http"',
      errors: [{ messageId: "transport" }],
    },
  ],
})

tester.run("test-waits", testWaits, {
  valid: [
    {
      filename: testFile,
      code: 'import { eventually } from "../test/eventually"; function* f() { yield* eventually(check) }',
    },
    {
      filename: join(root, "apps/desktop/test/eventually.ts"),
      code: readFileSync(join(root, "apps/desktop/test/eventually.ts"), "utf8"),
    },
    {
      filename: join(root, "apps/server/test/eventually.ts"),
      code: readFileSync(join(root, "apps/server/test/eventually.ts"), "utf8"),
    },
    {
      filename: testFile,
      code: 'import { waitFor } from "@testing-library/react"; await waitFor(check)',
    },
    { filename: testFile, code: "const vi = { waitFor() {} }; vi.waitFor(check)" },
    {
      filename: testFile,
      code: 'import { vi } from "vite-plus/test"; function f(vi) { vi.waitFor(check) }',
    },
    {
      filename: testFile,
      code: 'import { vi } from "vite-plus/test"; vi.advanceTimersByTime(5000)',
    },
    {
      filename: testFile,
      code: 'import { TestClock } from "effect/testing"; function* f() { yield* TestClock.adjust("1 minute") }',
    },
    {
      filename: testFile,
      code: 'import { Effect } from "effect"; function* f() { yield* work.pipe(Effect.timeout("1 minute")) }',
    },
    {
      filename: testFile,
      code: 'import { Effect, Fiber } from "effect"; import { TestClock } from "effect/testing"; function* f() { const fiber = yield* Effect.sleep("1 minute").pipe(Effect.forkChild()); yield* TestClock.adjust("2 minutes"); yield* Fiber.join(fiber) }',
    },
    { filename: testFile, code: "setTimeout(() => send(response), 100)" },
    {
      filename: testFile,
      code: "await new Promise(resolve => { event.once('done', resolve); setTimeout(resolve, 1000) })",
    },
    {
      filename: testFile,
      code: "const fakeResponse = () => new Promise(resolve => setTimeout(resolve, 20))",
    },
    {
      filename: testFile,
      code: "function f(setTimeout) { return new Promise(resolve => setTimeout(resolve, 20)) }",
    },
    {
      filename: testFile,
      code: "const Promise = CustomPromise; new Promise(resolve => setTimeout(resolve, 20))",
    },
    {
      filename: backend,
      code: 'import { Effect } from "effect"; function* f() { yield* Effect.sleep("1 second") }',
    },
  ],
  invalid: [
    ...[
      'import { vi } from "vite-plus/test"; await vi.waitFor(check)',
      'import { vi as v } from "vitest"; await v.waitFor(check)',
      'import { vi as v } from "@effect/vitest"; await v.waitFor(check)',
      'import { vitest as v } from "vitest"; v["waitFor"](check)',
      'import * as test from "vite-plus/test"; test.vi.waitFor(check)',
      'import { vi } from "vitest"; const poll = vi.waitFor; poll(check)',
      'import { vi } from "vitest"; const { waitFor: poll } = vi; poll(check)',
      'import { vi } from "vite-plus/test"; const v = vi; const { waitFor } = v; waitFor(check)',
      "vi.waitFor(check)",
    ].map((code) => ({ filename: testFile, code, errors: [{ messageId: "wait" }] })),
    ...[
      'import { Effect } from "effect"; function* f() { yield* Effect.sleep("20 millis") }',
      'import { Effect as E } from "effect"; function* f() { yield* E.sleep(20) }',
      'import * as Effect from "effect/Effect"; function* f() { yield* Effect.sleep(20) }',
      'import { sleep as delay } from "effect/Effect"; function* f() { yield* delay(20) }',
      'import { Effect } from "effect"; const { sleep: delay } = Effect; function* f() { yield* delay(20) }',
      'import { setTimeout as delay } from "node:timers/promises"; await delay(20)',
      'import * as timers from "timers/promises"; await timers.setTimeout(20)',
      "await new Promise(resolve => setTimeout(resolve, 20))",
      "await new Promise(resolve => setTimeout(() => resolve(), 20))",
      "await new Promise(resolve => globalThis.setTimeout(() => { resolve() }, 20))",
      'import { setTimeout as later } from "node:timers"; await new Promise(resolve => later(resolve, 20))',
    ].map((code) => ({ filename: testFile, code, errors: [{ messageId: "sleep" }] })),
  ],
})

void it("registers both policies in the real root lint CLI and accepts the supported helper", () => {
  const filename = join(root, `apps/desktop/src/renderer/policy-${process.pid}.test.ts`)
  const production = filename.replace(".test.ts", ".ts")
  const cli = join(root, "node_modules/vite-plus/bin/vp")
  const created = new Set<string>()

  const lint = (file: string) =>
    spawnSync(process.execPath, [cli, "lint", file, "--format", "json"], {
      cwd: root,
      encoding: "utf8",
    })

  try {
    writeFileSync(production, 'export { ServerLive } from "../../../server/src/server"\n', {
      flag: "wx",
    })
    created.add(production)
    const forbidden = lint(production)
    assert.equal(forbidden.status, 1, forbidden.stdout + forbidden.stderr)
    assert.match(forbidden.stdout, /glass\(architecture\)/)
    unlinkSync(production)

    // The direct short-default wait removed from Discussions.test.tsx by 3511ddf.
    const historical = `import { expect, it, vi } from "vite-plus/test"
import { screen } from "@testing-library/react"

it("waits for resolution", async () => {
  await vi.waitFor(() => expect(screen.queryByText("Resolving…")).toBeNull())
})
`

    writeFileSync(filename, historical, { flag: "wx" })
    created.add(filename)
    const rejected = lint(filename)
    assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr)
    assert.match(rejected.stdout, /glass\(test-waits\)/)
    assert.match(rejected.stdout, /apps\/desktop\/test\/eventually.ts/)

    writeFileSync(
      filename,
      historical
        .replace("expect, it, vi", "expect, it")
        .replace(
          "import { screen }",
          'import { eventually } from "../../test/eventually"\nimport { screen }',
        )
        .replace("vi.waitFor", "eventually"),
    )
    const supported = lint(filename)
    assert.equal(supported.status, 0, supported.stdout + supported.stderr)
  } finally {
    for (const file of created) rmSync(file, { force: true })
  }
})
