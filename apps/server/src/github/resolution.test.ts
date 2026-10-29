import { assert, describe, it } from "@effect/vitest"
import { DiscussionNotFound, PullRequestRef } from "@glass/contracts"
import { Effect } from "effect"
import { startSignedInBackend } from "../../test/harness"

const base = { sha: "b0", files: { "greet.ts": "hello\nworld\n" } }

const head = { sha: "h1", files: { "greet.ts": "hello\nthere\nworld\n" } }

const patch = "@@ -1,2 +1,3 @@\n hello\n+there\n world"

const changedFiles = [{ path: "greet.ts", status: "modified", additions: 1, patch }] as const

const thread = {
  path: "greet.ts",
  line: 2,
  side: "RIGHT",
  comments: [{ author: "hubot", bodyHtml: "<p>Why <code>there</code>?</p>" }],
} as const

describe("Discussion resolution", () => {
  it.live("resolves a Discussion, then unresolves it, and a repeat resolve stays resolved", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head, changedFiles })
      const discussion = pr.addReviewThread(thread)

      assert.strictEqual(
        yield* client.SetDiscussionResolved({ discussionId: discussion.id, resolved: true }),
        true,
      )
      assert.strictEqual(
        (yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })).discussions
          .onLines[0]?.resolved,
        true,
      )

      assert.strictEqual(
        yield* client.SetDiscussionResolved({ discussionId: discussion.id, resolved: true }),
        true,
      )
      assert.strictEqual(pr.reviewThreads[0]?.resolved, true)

      assert.strictEqual(
        yield* client.SetDiscussionResolved({ discussionId: discussion.id, resolved: false }),
        false,
      )
      assert.strictEqual(
        (yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })).discussions
          .onLines[0]?.resolved,
        false,
      )
      assert.strictEqual(pr.reviewThreads[0]?.resolved, false)
    }),
  )

  it.live("fails a Discussion that's gone and leaves the others unresolved", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head, changedFiles })
      const discussion = pr.addReviewThread(thread)

      assert.deepStrictEqual(
        yield* client
          .SetDiscussionResolved({ discussionId: "PRRT_gone", resolved: true })
          .pipe(Effect.flip),
        new DiscussionNotFound({ id: "PRRT_gone" }),
      )
      assert.strictEqual(pr.reviewThreads[0]?.id, discussion.id)
      assert.strictEqual(pr.reviewThreads[0]?.resolved, false)
    }),
  )

  it.live("propagates a GitHub failure without resolving the Discussion", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head, changedFiles })
      const discussion = pr.addReviewThread(thread)

      github.failNextGraphQL({ type: "FORBIDDEN", message: "Not permitted" })

      assert.strictEqual(
        (yield* client
          .SetDiscussionResolved({ discussionId: discussion.id, resolved: true })
          .pipe(Effect.flip))._tag,
        "GitHubUnavailable",
      )
      assert.strictEqual(pr.reviewThreads[0]?.resolved, false)
      assert.strictEqual(
        (yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })).discussions
          .onLines[0]?.resolved,
        false,
      )
    }),
  )
})
