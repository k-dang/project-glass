import { assert, describe, it } from "@effect/vitest"
import {
  FollowedRepository,
  InvalidRepositoryInput,
  PullRequestRef,
  SettingsError,
} from "@glass/contracts"
import { Effect } from "effect"
import { mkdir, readFile, writeFile, rm, rename } from "node:fs/promises"
import { join } from "node:path"
import { isolatedHome, startBackend, startSignedInBackend } from "../test/harness"

describe("followed repositories", () => {
  it.live("starts empty and persists follows and unfollows across backend restarts", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const glass = new FollowedRepository({ owner: "octo-org", repo: "glass" })
      const effect = new FollowedRepository({ owner: "effect-ts", repo: "effect" })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* startBackend({}, home)
          assert.deepStrictEqual(yield* client.ListFollowedRepositories(), [])
          assert.deepStrictEqual(yield* client.FollowRepository({ input: " Octo-Org/Glass " }), [
            glass,
          ])
          assert.deepStrictEqual(
            yield* client.FollowRepository({ input: "https://github.com/Effect-TS/effect.git/" }),
            [effect, glass],
          )
          assert.deepStrictEqual(
            yield* client.FollowRepository({ input: "https://github.com/OCTO-ORG/GLASS" }),
            [effect, glass],
          )
        }),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* startBackend({}, home)
          assert.deepStrictEqual(yield* client.ListFollowedRepositories(), [effect, glass])
          assert.deepStrictEqual(yield* client.UnfollowRepository({ repository: glass }), [effect])
        }),
      )

      const { client } = yield* startBackend({}, home)
      assert.deepStrictEqual(yield* client.ListFollowedRepositories(), [effect])
      assert.deepStrictEqual(
        JSON.parse(
          yield* Effect.promise(() =>
            readFile(join(home, ".project-glass", "settings.json"), "utf8"),
          ),
        ).followedRepositories,
        [{ owner: "effect-ts", repo: "effect" }],
      )
    }),
  )

  it.live("rejects invalid input without changing the saved configuration", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const configuration = join(home, ".project-glass", "settings.json")
      const { client } = yield* startBackend({}, home)
      const followed = yield* client.FollowRepository({ input: "octo-org/glass" })
      const saved = yield* Effect.promise(() => readFile(configuration))

      for (const input of [
        "",
        "glass",
        "https://example.com/owner/repo",
        "owner/repo/pull/1",
        "owner/..",
        "https://github.com/owner/repo?tab=readme",
        "owner/repo#123",
      ]) {
        assert.instanceOf(
          yield* Effect.flip(client.FollowRepository({ input })),
          InvalidRepositoryInput,
        )
        assert.deepStrictEqual(yield* Effect.promise(() => readFile(configuration)), saved)
      }

      assert.deepStrictEqual(yield* client.ListFollowedRepositories(), followed)
    }),
  )

  it.live("preserves an unusable configuration directory and recovers after repair", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const configuration = join(home, ".project-glass", "settings.json")
      const marker = join(configuration, "keep.txt")
      const markerBytes = Buffer.from("preserve this file")
      const { client } = yield* startBackend({}, home)
      yield* Effect.promise(() => rm(configuration))
      yield* Effect.promise(() => mkdir(configuration))
      yield* Effect.promise(() => writeFile(marker, markerBytes))

      assert.instanceOf(
        yield* Effect.flip(client.FollowRepository({ input: "octo-org/glass" })),
        SettingsError,
      )
      assert.deepStrictEqual(yield* Effect.promise(() => readFile(marker)), markerBytes)
      yield* Effect.promise(() => rm(configuration, { recursive: true }))
      const followed = yield* client.FollowRepository({ input: "octo-org/glass" })

      const saved = join(home, "saved")
      yield* Effect.promise(() => rename(configuration, saved))
      yield* Effect.promise(() => mkdir(configuration))
      yield* Effect.promise(() => writeFile(marker, markerBytes))
      assert.instanceOf(
        yield* Effect.flip(client.UnfollowRepository({ repository: followed[0]! })),
        SettingsError,
      )
      assert.deepStrictEqual(yield* Effect.promise(() => readFile(marker)), markerBytes)
      yield* Effect.promise(() => rm(configuration, { recursive: true }))
      yield* Effect.promise(() => rename(saved, configuration))

      assert.deepStrictEqual(yield* client.ListFollowedRepositories(), followed)
    }),
  )

  it.live(
    "surfaces unreadable configuration rather than treating it as empty or overwriting it",
    () =>
      Effect.gen(function* () {
        const home = yield* isolatedHome
        const configuration = join(home, ".project-glass", "settings.json")
        const corrupt = Buffer.from("invalid json")
        const { client } = yield* startBackend({}, home)
        yield* client.FollowRepository({ input: "octo-org/glass" })
        yield* Effect.promise(() => writeFile(configuration, corrupt))

        assert.instanceOf(yield* Effect.flip(client.ListFollowedRepositories()), SettingsError)
        assert.deepStrictEqual(yield* Effect.promise(() => readFile(configuration)), corrupt)
        assert.instanceOf(
          yield* Effect.flip(client.FollowRepository({ input: "effect-ts/effect" })),
          SettingsError,
        )
        assert.deepStrictEqual(yield* Effect.promise(() => readFile(configuration)), corrupt)
      }),
  )

  it.live("retains concurrent follows and permits direct PR opening outside the followed set", () =>
    Effect.gen(function* () {
      const { client, github } = yield* startSignedInBackend
      yield* Effect.all(
        [
          client.FollowRepository({ input: "octo-org/glass" }),
          client.FollowRepository({ input: "effect-ts/effect" }),
        ],
        { concurrency: "unbounded" },
      )
      const followed = yield* client.ListFollowedRepositories()
      assert.deepStrictEqual(followed, [
        new FollowedRepository({ owner: "effect-ts", repo: "effect" }),
        new FollowedRepository({ owner: "octo-org", repo: "glass" }),
      ])

      const pr = github.seedPullRequest({
        owner: "other-org",
        repo: "other-repo",
        number: 1,
        base: { sha: "b0", files: {} },
        head: { sha: "h1", files: {} },
      })

      assert.strictEqual(
        (yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })).pullRequest.url,
        pr.url,
      )
      assert.deepStrictEqual(yield* client.ListFollowedRepositories(), followed)
    }),
  )
})
