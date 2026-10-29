import { assert, describe, it } from "@effect/vitest"
import {
  DiscussionNotFound,
  DraftsBlockReply,
  GitHubUnavailable,
  PublishedComment,
  PullRequestRef,
} from "@glass/contracts"
import { DateTime, Effect, Fiber, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { avatarUrl } from "../../test/fakeNodes"
import { VIEWER } from "../../test/fakePullRequest"
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

const heldReplyBackend = Effect.gen(function* () {
  const deleting = Promise.withResolvers<string>()
  const release = Promise.withResolvers<void>()
  const operations: Array<string> = []

  const operation = Schema.Struct({
    operationName: Schema.String,
    variables: Schema.Struct({ id: Schema.optional(Schema.String) }),
  })

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)

    if (new URL(request.url).pathname === "/graphql") {
      const { operationName, variables } = Schema.decodeUnknownSync(operation)(
        await request.clone().json(),
      )

      operations.push(operationName)

      if (operationName === "DeletePullRequestReviewComment") {
        assert.isDefined(variables.id)
        deleting.resolve(variables.id)
        await release.promise
      }
    }

    return globalThis.fetch(request)
  }

  const backend = yield* startSignedInBackend.pipe(
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  )

  yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))

  return { ...backend, deleting: deleting.promise, release: release.resolve, operations }
})

describe("Replies", () => {
  it.live("publishes a Reply to a Discussion immediately", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head, changedFiles })
      const discussion = pr.addReviewThread(thread)

      const reply = yield* client.ReplyToDiscussion({
        discussionId: discussion.id,
        body: "To greet them.",
      })

      const published = pr.reviewThreads[0]!.comments[1]!

      assert.deepStrictEqual(
        reply,
        new PublishedComment({
          id: published.id,
          author: VIEWER.login,
          avatarUrl: avatarUrl(VIEWER.login),
          bodyHtml: "<p>To greet them.</p>",
          createdAt: DateTime.makeUnsafe(published.createdAt),
        }),
      )

      const { discussions } = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.deepStrictEqual(
        discussions.onLines[0]?.comments.map((comment) => comment.bodyHtml),
        ["<p>Why <code>there</code>?</p>", "<p>To greet them.</p>"],
      )
    }),
  )

  it.live("sends no Reply while the user has Drafts, which GitHub would hold it with", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      const pr = github.seedPullRequest({
        base,
        head,
        changedFiles,
        pendingReview: {
          drafts: [{ path: "greet.ts", line: 3, side: "RIGHT", body: "Nit", diffHunk: patch }],
        },
      })

      const discussion = pr.addReviewThread(thread)

      const error = yield* client
        .ReplyToDiscussion({ discussionId: discussion.id, body: "To greet them." })
        .pipe(Effect.flip)

      assert.deepStrictEqual(error, new DraftsBlockReply())
      assert.strictEqual(pr.reviewThreads[0]?.comments.length, 1)
      assert.deepStrictEqual(
        pr.pendingReview?.drafts.map((draft) => draft.body),
        ["Nit"],
      )
    }),
  )

  it.live(
    "sends a Reply and a Draft one at a time, taking back a held Reply before the Draft",
    () =>
      Effect.gen(function* () {
        const { github, client, deleting, release, operations } = yield* heldReplyBackend

        const pr = github.seedPullRequest({
          base,
          head,
          changedFiles,
          pendingReview: {
            drafts: [{ path: "greet.ts", line: 3, side: "RIGHT", body: "Nit", diffHunk: patch }],
          },
        })

        const discussion = pr.addReviewThread(thread)

        const { pullRequest, revision } = yield* client.OpenPullRequest({
          pullRequest: new PullRequestRef(pr),
        })

        operations.length = 0

        const reply = yield* client
          .ReplyToDiscussion({ discussionId: discussion.id, body: "To greet them." })
          .pipe(Effect.flip, Effect.forkChild())

        const deletingId = yield* Effect.promise(() => deleting)

        assert.deepStrictEqual(
          pr.pendingReview?.drafts.map((draft) => draft.body),
          ["Nit", "To greet them."],
        )
        assert.strictEqual(deletingId, pr.pendingReview?.drafts[1]?.id)

        const creating = yield* client
          .CreateDraft({
            pullRequestId: pullRequest.id,
            revision,
            path: "greet.ts",
            side: "new",
            line: 2,
            body: "Why?",
          })
          .pipe(Effect.forkChild({ startImmediately: true }))

        yield* client.GetConnection()

        assert.deepStrictEqual(operations, [
          "AddPullRequestReviewThreadReply",
          "DeletePullRequestReviewComment",
        ])
        assert.deepStrictEqual(
          pr.pendingReview?.drafts.map((draft) => draft.body),
          ["Nit", "To greet them."],
        )

        release()

        assert.deepStrictEqual(yield* Fiber.join(reply), new DraftsBlockReply())
        assert.strictEqual((yield* Fiber.join(creating)).body, "Why?")
        assert.deepStrictEqual(operations, [
          "AddPullRequestReviewThreadReply",
          "DeletePullRequestReviewComment",
          "PullRequestRevision",
          "AddPullRequestReviewThread",
        ])
        assert.deepStrictEqual(
          pr.pendingReview?.drafts.map((draft) => draft.body),
          ["Nit", "Why?"],
        )
      }),
  )

  it.live("takes back a held Reply after cancellation before allowing a Review to publish", () =>
    Effect.gen(function* () {
      const { github, client, deleting, release, operations } = yield* heldReplyBackend

      const pr = github.seedPullRequest({
        base,
        head,
        changedFiles,
        pendingReview: {
          drafts: [{ path: "greet.ts", line: 3, side: "RIGHT", body: "Nit", diffHunk: patch }],
        },
      })

      const discussion = pr.addReviewThread(thread)

      const { pullRequest, revision } = yield* client.OpenPullRequest({
        pullRequest: new PullRequestRef(pr),
      })

      operations.length = 0

      const reply = yield* client
        .ReplyToDiscussion({ discussionId: discussion.id, body: "To greet them." })
        .pipe(Effect.forkChild())

      const deletingId = yield* Effect.promise(() => deleting)

      assert.deepStrictEqual(
        pr.pendingReview?.drafts.map((draft) => draft.body),
        ["Nit", "To greet them."],
      )
      assert.strictEqual(deletingId, pr.pendingReview?.drafts[1]?.id)

      yield* Fiber.interrupt(reply)

      const review = yield* client
        .SubmitReview({
          pullRequestId: pullRequest.id,
          revision,
          decision: "comment",
          summary: "",
        })
        .pipe(Effect.forkChild({ startImmediately: true }))

      yield* client.GetConnection()

      assert.deepStrictEqual(operations, [
        "AddPullRequestReviewThreadReply",
        "DeletePullRequestReviewComment",
      ])
      assert.deepStrictEqual(
        pr.pendingReview?.drafts.map((draft) => draft.body),
        ["Nit", "To greet them."],
      )
      assert.deepStrictEqual(pr.reviews, [])

      release()
      yield* Fiber.join(review)

      assert.deepStrictEqual(operations, [
        "AddPullRequestReviewThreadReply",
        "DeletePullRequestReviewComment",
        "PullRequestRevision",
        "SubmitPullRequestReview",
      ])
      assert.isUndefined(pr.pendingReview)
      assert.strictEqual(pr.reviews.length, 1)

      assert.deepStrictEqual(
        pr.reviewThreads.flatMap((reviewThread) =>
          reviewThread.comments.map((comment) => comment.bodyHtml),
        ),
        ["<p>Why <code>there</code>?</p>", "<p>Nit</p>"],
      )
    }),
  )

  it.live("fails a blank Reply, which GitHub doesn't take", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head, changedFiles })
      const discussion = pr.addReviewThread(thread)

      const error = yield* client
        .ReplyToDiscussion({ discussionId: discussion.id, body: "  " })
        .pipe(Effect.flip)

      assert.deepStrictEqual(
        error,
        new GitHubUnavailable({
          message: "GitHub didn't accept the Reply. Try again in a moment.",
        }),
      )
      assert.strictEqual(pr.reviewThreads[0]?.comments.length, 1)
    }),
  )

  it.live("fails to reply to a Discussion that's gone from GitHub", () =>
    Effect.gen(function* () {
      const { client } = yield* startSignedInBackend

      const error = yield* client
        .ReplyToDiscussion({ discussionId: "PRRT_gone", body: "Hm" })
        .pipe(Effect.flip)

      assert.deepStrictEqual(error, new DiscussionNotFound({ id: "PRRT_gone" }))
    }),
  )
})
