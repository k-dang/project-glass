import { assert, describe, it } from "@effect/vitest"
import { PullRequestRef, StaleRevision } from "@glass/contracts"
import { Effect } from "effect"
import { startSignedInBackend } from "../../test/harness"

const base = { sha: "b0", files: { "name.ts": "export {}\n" } }

const head = { sha: "h1", files: { "renamed.ts": "export {}\n" } }

describe("Viewed files", () => {
  it.live("loads every page, treating dismissed markers as not viewed", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const paths = Array.from({ length: 205 }, (_, i) => `src/file-${i}.ts`)

      const pr = github.seedPullRequest({
        base: { sha: "b0", files: {} },
        head: { sha: "h1", files: Object.fromEntries(paths.map((path) => [path, "hi\n"])) },
        changedFiles: paths.map((path, i) => ({
          path,
          status: "added",
          viewerViewedState: i % 2 === 0 ? "VIEWED" : "DISMISSED",
        })),
      })

      const workspace = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.deepStrictEqual(
        workspace.viewedPaths,
        paths.filter((_, i) => i % 2 === 0),
      )
    }),
  )

  it.live("marks and unmarks a pure rename on GitHub, surviving a reload", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      const pr = github.seedPullRequest({
        base,
        head,
        changedFiles: [{ path: "renamed.ts", previousPath: "name.ts", status: "renamed" }],
      })

      const { revision } = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })
      const file = { pullRequestId: pr.id, revision, path: "renamed.ts" }

      yield* client.SetFileViewed({ ...file, viewed: true })

      assert.deepStrictEqual(
        (yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })).viewedPaths,
        ["renamed.ts"],
      )

      yield* client.SetFileViewed({ ...file, viewed: false })

      assert.deepStrictEqual(
        (yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })).viewedPaths,
        [],
      )
    }),
  )

  it.live("refuses stale markers and propagates GitHub failures without writing", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      const pr = github.seedPullRequest({
        base,
        head,
        changedFiles: [{ path: "renamed.ts", status: "added" }],
      })

      const { revision } = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })
      const file = { pullRequestId: pr.id, revision, path: "renamed.ts", viewed: true }

      github.beforeNext("/graphql", () => {
        github.beforeNext("/graphql", () => {
          github.failNextGraphQL({ type: "FORBIDDEN", message: "Not permitted" })
        })
      })

      assert.strictEqual((yield* Effect.flip(client.SetFileViewed(file)))._tag, "GitHubUnavailable")
      assert.deepStrictEqual([...pr.viewedPaths], [])

      pr.push({ head: { ...head, sha: "h2" } })

      assert.deepStrictEqual(yield* Effect.flip(client.SetFileViewed(file)), new StaleRevision())
      assert.deepStrictEqual([...pr.viewedPaths], [])
    }),
  )
})
