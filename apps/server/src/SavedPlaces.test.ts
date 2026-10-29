import { assert, it } from "@effect/vitest"
import { PullRequestRef, Revision, type ReviewDestination, SavedPlaceError } from "@glass/contracts"
import { DateTime, Effect } from "effect"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { isolatedHome, startBackend } from "../test/harness"
import { startFakeGitHub } from "../test/fakeGitHub"
import { VIEWER } from "../test/fakePullRequest"

it.live(
  "keeps one saved place and its workspace identity across restarts while GitHub is unavailable",
  () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const requests: Array<string> = []

      const github = yield* startFakeGitHub({
        beforeRequest: ({ path }) => {
          requests.push(path)

          return 503
        },
      })

      const env = { GH_TOKEN: VIEWER.token, GLASS_GITHUB_API_URL: github.url }

      const destination: ReviewDestination = {
        area: "reviews",
        login: VIEWER.login,
        pullRequest: new PullRequestRef({ owner: "octo-org", repo: "glass", number: 42 }),
        revision: new Revision({ base: "b0", head: "h1" }),
        position: { tab: "changes", file: "server.ts", order: "tour" },
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* startBackend(env, home)
          assert.isNull(yield* client.GetSavedPlace())

          const saved = yield* client.SavePlace({ destination })
          assert.deepStrictEqual(saved.destination, destination)
          assert.isTrue(DateTime.toEpochMillis(saved.savedAt) <= Date.now())
        }),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* startBackend(env, home)
          assert.deepStrictEqual((yield* client.GetSavedPlace())?.destination, destination)

          yield* client.SavePlace({
            destination: {
              ...destination,
              pullRequest: new PullRequestRef({ owner: "octo-org", repo: "glass", number: 43 }),
              position: { tab: "files", file: "README.md" },
            },
          })
        }),
      )

      const { client } = yield* startBackend(env, home)
      const latest = yield* client.GetSavedPlace()
      assert.deepInclude(latest?.destination, {
        pullRequest: new PullRequestRef({ owner: "octo-org", repo: "glass", number: 43 }),
        position: { tab: "files", file: "README.md" },
      })
      assert.deepStrictEqual(requests, [])
    }),
)

it.live("reports an unsupported saved destination without preventing other work", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    yield* Effect.scoped(startBackend({}, home))

    const database = new DatabaseSync(join(home, ".project-glass", "glass.db"))

    try {
      database
        .prepare("INSERT INTO saved_place (id, destination, saved_at) VALUES (1, ?, ?)")
        .run(JSON.stringify({ area: "unsupported" }), "2026-10-25T18:30:00Z")
    } finally {
      database.close()
    }

    const { client } = yield* startBackend({}, home)
    const failure = yield* Effect.flip(client.GetSavedPlace())
    assert.instanceOf(failure, SavedPlaceError)
    assert.deepStrictEqual(yield* client.ListToDos(), [])
  }),
)
