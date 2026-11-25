import type { BackendEndpoint } from "@glass/contracts/desktop"
import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Queue } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type BackendProcess, launchBackend, threadFileUrl, visualizationUrl } from "./backend"
import { threadFileOf } from "./browserPanes"

const endpoint = { url: "ws://127.0.0.1:4000/rpc", token: "secret" }

const THREAD = "5633ec51-c031-4536-9a4e-a6663268a894"

const backendUrlOf = (address: string, initiator: { initiatorOrigin?: string } = {}) => {
  const file = threadFileOf(Object.assign(new Request(address), initiator))

  return file === null ? null : threadFileUrl(endpoint, "sandbox", file)
}

describe("a Thread file's backend URL", () => {
  it("names the pane's place, the Thread and each path segment", () => {
    expect(backendUrlOf(`glass-file://${THREAD}/docs/my%20plan/index.html`)).toBe(
      `http://127.0.0.1:4000/thread-files/sandbox/${THREAD}/docs/my%20plan/index.html?token=secret`,
    )
  })

  it("keeps the path inside the Thread's files", () => {
    expect([
      backendUrlOf(`glass-file://${THREAD}/a%2F..%2F..%2Fb`),
      backendUrlOf(`glass-file://${THREAD}/%2e%2e/%2E%2e/health`),
    ]).toEqual([
      `http://127.0.0.1:4000/thread-files/sandbox/${THREAD}/a%2F..%2F..%2Fb?token=secret`,
      `http://127.0.0.1:4000/thread-files/sandbox/${THREAD}/health?token=secret`,
    ])
  })

  it("serves a page only its own Thread's files", () => {
    expect([
      backendUrlOf(`glass-file://${THREAD}/notes.md`, {
        initiatorOrigin: `glass-file://${THREAD}`,
      }),
      backendUrlOf(`glass-file://${THREAD}/notes.md`, {
        initiatorOrigin: "glass-file://9f6e95a4-990e-4067-b2ef-6f284d5d1adb",
      }),
      backendUrlOf(`glass-file://${THREAD}/notes.md`, { initiatorOrigin: "https://example.com" }),
    ]).toEqual([
      `http://127.0.0.1:4000/thread-files/sandbox/${THREAD}/notes.md?token=secret`,
      null,
      null,
    ])
  })

  it.each([
    "glass-file://../visualizations/x",
    "glass-file://./health",
    "glass-file://not-a-thread/index.html",
    `glass-file://${THREAD}/`,
    `glass-file://${THREAD}/%E0%A4%A`,
  ])("refuses %s", (address) => expect(backendUrlOf(address)).toBeNull())
})

describe("visualizationUrl", () => {
  it.each(["..", ".", "health"])("refuses the id %s", (id) =>
    expect(visualizationUrl(endpoint, id)).toBeNull(),
  )
})

const fakeBackend = (env: Readonly<Record<string, string>>) => {
  const ready = Promise.withResolvers<void>()
  const exited = Promise.withResolvers<number>()
  const stopAsked = Promise.withResolvers<void>()
  let running = true
  let killed = false

  const exit = (code: number) => {
    running = false
    exited.resolve(code)
  }

  const process: BackendProcess = {
    ready: ready.promise,
    exited: exited.promise,
    running: () => running,
    stop: () => stopAsked.resolve(),
    kill: () => {
      killed = true
      exit(1)
    },
  }

  return {
    env,
    port: Number(env["GLASS_PORT"]),
    process,
    reportReady: ready.resolve,
    exit,
    stopAsked: stopAsked.promise,
    killed: () => killed,
  }
}

type FakeBackend = ReturnType<typeof fakeBackend>

const launches = Effect.gen(function* () {
  const dataDirectory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "glass-backend-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  )

  const forked = yield* Queue.unbounded<FakeBackend>()
  const endpoints = yield* Queue.unbounded<BackendEndpoint>()
  const notes: Array<string> = []

  const launch = launchBackend({
    fork: (env) => {
      const backend = fakeBackend(env)
      Queue.offerUnsafe(forked, backend)

      return backend.process
    },
    rendererOrigin: "glass://app",
    dataDirectory,
    onReady: (ready) => Queue.offerUnsafe(endpoints, ready),
    onDown: () => {},
    note: (_, message) => Effect.sync(() => notes.push(message)),
  }).pipe(Effect.forkChild)

  return { launch, forked, endpoints, notes }
})

const squat = (port: number) => {
  const requests: Array<string> = []

  const server = createServer((request, response) => {
    requests.push(request.url ?? "")
    response.end()
  })

  return Effect.acquireRelease(
    Effect.promise(() => new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))),
    () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  ).pipe(Effect.as(requests))
}

describe("launchBackend", () => {
  it.effect("mints a new token each launch", () =>
    Effect.gen(function* () {
      const { launch, forked, endpoints } = yield* launches

      const launched = Effect.gen(function* () {
        const running = yield* launch
        const backend = yield* Queue.take(forked)
        backend.reportReady()
        const reported = yield* Queue.take(endpoints)
        backend.exit(1)
        const error = yield* Effect.flip(Fiber.join(running))

        assert.strictEqual(error.message, "Backend exited with code 1")
        assert.deepStrictEqual(reported, {
          url: `ws://127.0.0.1:${backend.port}/rpc`,
          token: backend.env["GLASS_TOKEN"],
        })

        return reported.token
      })

      assert.notStrictEqual(yield* launched, yield* launched)
    }),
  )

  it.effect("never hands the token to a server squatting the backend's port", () =>
    Effect.gen(function* () {
      const { launch, forked, endpoints } = yield* launches

      const running = yield* launch
      const backend = yield* Queue.take(forked)
      const requests = yield* squat(backend.port)
      backend.exit(1)
      yield* Effect.flip(Fiber.join(running))

      assert.deepStrictEqual(requests, [])
      assert.strictEqual(yield* Queue.size(endpoints), 0)
    }),
  )

  it.effect("stops by asking the backend to shut down and waiting for it to exit", () =>
    Effect.gen(function* () {
      const { launch, forked, endpoints, notes } = yield* launches

      const running = yield* launch
      const backend = yield* Queue.take(forked)
      backend.reportReady()
      yield* Queue.take(endpoints)

      const stopping = yield* Fiber.interrupt(running).pipe(Effect.forkChild)
      yield* Effect.promise(() => backend.stopAsked)
      backend.exit(0)
      yield* Fiber.join(stopping)

      assert.isFalse(backend.killed())
      assert.include(notes, "Backend stopped with code 0")
    }),
  )
})
