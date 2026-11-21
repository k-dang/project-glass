import { assert, describe, it } from "@effect/vitest"
import { GitHubUnavailable, PullRequestRef, Revision, StaleRevision } from "@glass/contracts"
import { Deferred, Effect, Fiber, Redacted, Schema } from "effect"
import { startFakeGitHub } from "../../test/fakeGitHub"
import { VIEWER } from "../../test/fakePullRequest"
import { clientWith } from "../../test/gitHubClient"

const FILES = "GET /repos/acme/api/pulls/42/files"

const Operation = Schema.Struct({ operationName: Schema.String })

const kindOf = async (request: Request) =>
  request.method === "POST"
    ? Schema.decodeUnknownSync(Operation)(await request.clone().json()).operationName
    : `${request.method} ${new URL(request.url).pathname}`

const startRelay = Effect.gen(function* () {
  const github = yield* startFakeGitHub()

  const pr = github.seedPullRequest({
    owner: "acme",
    repo: "api",
    number: 42,
    base: { sha: "b0", files: { "greet.ts": "hi\n" } },
    head: { sha: "h1", files: { "greet.ts": "hello\n" } },
    changedFiles: [
      { path: "greet.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@" },
    ],
  })

  const requests: Array<string> = []
  const arrivals = new Map<string, Deferred.Deferred<void>>()
  const holds = new Map<string, Deferred.Deferred<void>>()
  const failing = new Map<string, number>()

  const arrival = (kind: string) => {
    const known = arrivals.get(kind)

    if (known !== undefined) return known

    const made = Deferred.makeUnsafe<void>()
    arrivals.set(kind, made)

    return made
  }

  const client = yield* clientWith(
    async (input, init) => {
      const request = new Request(input, init)
      const kind = await kindOf(request)
      requests.push(kind)
      Deferred.doneUnsafe(arrival(kind), Effect.void)

      const hold = holds.get(kind)

      if (hold !== undefined) {
        const aborted = new Promise<never>((_resolve, reject) =>
          request.signal.addEventListener("abort", () => reject(new Error("Aborted")), {
            once: true,
          }),
        )

        await Promise.race([Effect.runPromise(Deferred.await(hold)), aborted])
      }

      const status = failing.get(kind)

      if (status !== undefined) {
        failing.delete(kind)

        return new Response(null, { status })
      }

      const { pathname, search } = new URL(request.url)

      return fetch(`${github.url}${pathname}${search}`, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" ? null : await request.text(),
        signal: request.signal,
      })
    },
    { resolveToken: Effect.succeed({ token: Redacted.make(VIEWER.token), source: "gh" as const }) },
  )

  return {
    client,
    github,
    pr,
    ref: new PullRequestRef({ owner: "acme", repo: "api", number: 42 }),
    revision: new Revision({ base: "b0", head: "h1" }),
    requests,
    arrived: (kind: string) => Deferred.await(arrival(kind)),
    failNext: (kind: string, status: number) => {
      failing.set(kind, status)
    },
    hold: (kind: string) => {
      const release = Deferred.makeUnsafe<void>()
      holds.set(kind, release)

      return Deferred.succeed(release, undefined)
    },
  }
})

describe("Reading Tour and Agent review inputs", () => {
  it.live("a Tour reads changed files while its metadata read is still out", () =>
    Effect.gen(function* () {
      const { client, ref, revision, arrived, hold } = yield* startRelay
      const release = hold("TourInput")

      const reading = yield* client
        .tourInput(ref, revision)
        .pipe(Effect.forkChild({ startImmediately: true }))

      yield* arrived(FILES)
      yield* release
      const input = yield* Fiber.join(reading)

      assert.deepStrictEqual(
        input.files.map(({ path }) => path),
        ["greet.ts"],
      )
    }),
  )

  it.live(
    "an Agent review reads changed files alongside its metadata, and comments once it has the PR's id",
    () =>
      Effect.gen(function* () {
        const { client, ref, revision, requests, arrived, hold } = yield* startRelay
        const release = hold("TourInput")

        const reading = yield* client
          .reviewInput(ref, revision)
          .pipe(Effect.forkChild({ startImmediately: true }))

        yield* arrived("TourInput")
        yield* arrived(FILES)
        assert.deepStrictEqual(requests.toSorted(), [FILES, "TourInput"])

        yield* release
        const input = yield* Fiber.join(reading)

        assert.deepStrictEqual(
          input.files.map(({ path }) => path),
          ["greet.ts"],
        )
      }),
  )

  it.live(
    "a review read without a Revision reads changed files only once it knows the Revision",
    () =>
      Effect.gen(function* () {
        const { client, ref, requests, arrived, hold } = yield* startRelay
        const release = hold("TourInput")

        const reading = yield* client
          .reviewInput(ref, undefined)
          .pipe(Effect.forkChild({ startImmediately: true }))

        yield* arrived("TourInput")
        assert.notInclude(requests, FILES)

        yield* release
        const input = yield* Fiber.join(reading)

        assert.deepStrictEqual(input.revision, new Revision({ base: "b0", head: "h1" }))
      }),
  )

  it.live("a stale PR fails without waiting for the changed files", () =>
    Effect.gen(function* () {
      const { client, pr, ref, revision, hold } = yield* startRelay
      hold(FILES)
      pr.push({ head: { sha: "h2", files: { "greet.ts": "hello again\n" } } })

      assert.instanceOf(yield* Effect.flip(client.tourInput(ref, revision)), StaleRevision)
    }),
  )

  it.live("a stale PR wins over a changed-files read that failed first", () =>
    Effect.gen(function* () {
      const { client, pr, ref, revision, arrived, hold, failNext } = yield* startRelay
      const release = hold("TourInput")
      failNext(FILES, 503)

      const reading = yield* client
        .reviewInput(ref, revision)
        .pipe(Effect.forkChild({ startImmediately: true }))

      yield* arrived(FILES)
      pr.push({ head: { sha: "h2", files: { "greet.ts": "hello again\n" } } })
      yield* release

      const error = yield* Effect.flip(Fiber.join(reading))

      assert.notInstanceOf(error, GitHubUnavailable)
      assert.instanceOf(error, StaleRevision)
    }),
  )
})
