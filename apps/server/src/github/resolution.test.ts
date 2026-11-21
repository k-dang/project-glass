import { assert, describe, it } from "@effect/vitest"
import { ReviewThreadNotFound, PullRequestRef } from "@glass/contracts"
import { Effect } from "effect"
import { startSignedInBackend } from "../../test/harness"

const base = { sha: "b0", files: { "greet.ts": "hello\nworld\n" } }

const head = { sha: "h1", files: { "greet.ts": "hello\nthere\nworld\n" } }

const patch = "@@ -1,2 +1,3 @@\n hello\n+there\n world"

const changedFiles = [{ path: "greet.ts", status: "modified", additions: 1, patch }] as const

const greetLine = {
  path: "greet.ts",
  line: 2,
  side: "RIGHT",
  comments: [{ author: "hubot", bodyHtml: "<p>Why <code>there</code>?</p>" }],
} as const

describe("Review thread resolution", () => {
  it.live("resolves a Review thread, then unresolves it, and a repeat resolve stays resolved", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head, changedFiles })
      const reviewThread = pr.addReviewThread(greetLine)

      assert.strictEqual(
        yield* client.SetReviewThreadResolved({ reviewThreadId: reviewThread.id, resolved: true }),
        true,
      )
      assert.strictEqual(
        (yield* client.LoadPullRequest({ pullRequest: new PullRequestRef(pr) })).comments.onLines[0]
          ?.resolved,
        true,
      )

      assert.strictEqual(
        yield* client.SetReviewThreadResolved({ reviewThreadId: reviewThread.id, resolved: true }),
        true,
      )
      assert.strictEqual(pr.reviewThreads[0]?.resolved, true)

      assert.strictEqual(
        yield* client.SetReviewThreadResolved({ reviewThreadId: reviewThread.id, resolved: false }),
        false,
      )
      assert.strictEqual(
        (yield* client.LoadPullRequest({ pullRequest: new PullRequestRef(pr) })).comments.onLines[0]
          ?.resolved,
        false,
      )
      assert.strictEqual(pr.reviewThreads[0]?.resolved, false)
    }),
  )

  it.live("fails a Review thread that's gone and leaves the others unresolved", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head, changedFiles })
      const reviewThread = pr.addReviewThread(greetLine)

      assert.deepStrictEqual(
        yield* client
          .SetReviewThreadResolved({ reviewThreadId: "PRRT_gone", resolved: true })
          .pipe(Effect.flip),
        new ReviewThreadNotFound({ id: "PRRT_gone" }),
      )
      assert.strictEqual(pr.reviewThreads[0]?.id, reviewThread.id)
      assert.strictEqual(pr.reviewThreads[0]?.resolved, false)
    }),
  )

  it.live("propagates a GitHub failure without resolving the Review thread", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head, changedFiles })
      const reviewThread = pr.addReviewThread(greetLine)

      github.failNextGraphQL({ type: "FORBIDDEN", message: "Not permitted" })

      assert.strictEqual(
        (yield* client
          .SetReviewThreadResolved({ reviewThreadId: reviewThread.id, resolved: true })
          .pipe(Effect.flip))._tag,
        "GitHubUnavailable",
      )
      assert.strictEqual(pr.reviewThreads[0]?.resolved, false)
      assert.strictEqual(
        (yield* client.LoadPullRequest({ pullRequest: new PullRequestRef(pr) })).comments.onLines[0]
          ?.resolved,
        false,
      )
    }),
  )
})
