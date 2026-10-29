import { assert, describe, it } from "@effect/vitest"
import { PullRequestRef, ReviewRejected, StaleRevision } from "@glass/contracts"
import { Effect } from "effect"
import { startSignedInBackend } from "../../test/harness"
import { type FakePullRequest, VIEWER } from "../../test/fakePullRequest"

const base = { sha: "b0", files: { "greet.ts": "hello\nworld\n" } }

const head = { sha: "h1", files: { "greet.ts": "hello\nthere\nworld\n" } }

const patch = "@@ -1,2 +1,3 @@\n hello\n+there\n world"

const changedFiles = [{ path: "greet.ts", status: "modified", additions: 1, patch }] as const

const withDrafts = {
  base,
  head,
  changedFiles,
  pendingReview: {
    drafts: [
      { path: "greet.ts", line: 2, side: "RIGHT", body: "Why?", diffHunk: patch },
      { path: "greet.ts", line: 1, side: "LEFT", body: "Was", diffHunk: patch },
    ],
  },
} as const

const viewerCommentsByLine = (pr: FakePullRequest) =>
  pr.reviewThreads.flatMap(({ line, comments }) =>
    comments.flatMap(({ author, bodyHtml }) => (author === VIEWER.login ? [[line, bodyHtml]] : [])),
  )

describe("Submitting a Review", () => {
  it.live("publishes every Draft with a comment Review and its summary", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest(withDrafts)

      const { pullRequest, revision } = yield* client.OpenPullRequest({
        pullRequest: new PullRequestRef(pr),
      })

      yield* client.SubmitReview({
        pullRequestId: pullRequest.id,
        revision,
        decision: "comment",
        summary: "A few questions.",
      })

      assert.strictEqual(pr.pendingReview, undefined)
      assert.deepStrictEqual(viewerCommentsByLine(pr), [
        [2, "<p>Why?</p>"],
        [1, "<p>Was</p>"],
      ])
      assert.deepStrictEqual(
        pr.reviews.map(({ author, state, bodyHtml }) => ({ author, state, bodyHtml })),
        [{ author: VIEWER.login, state: "COMMENTED", bodyHtml: "<p>A few questions.</p>" }],
      )
    }),
  )

  it.live("publishes Drafts with an approval or requested changes, with no summary", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      for (const [decision, reviewState] of [
        ["approve", "APPROVED"],
        ["request-changes", "CHANGES_REQUESTED"],
      ] as const) {
        const pr = github.seedPullRequest(withDrafts)

        const { pullRequest, revision } = yield* client.OpenPullRequest({
          pullRequest: new PullRequestRef(pr),
        })

        yield* client.SubmitReview({
          pullRequestId: pullRequest.id,
          revision,
          decision,
          summary: "",
        })

        assert.strictEqual(pr.pendingReview, undefined)
        assert.strictEqual(viewerCommentsByLine(pr).length, 2)
        assert.deepStrictEqual(
          pr.reviews.map(({ state, bodyHtml }) => ({ state, bodyHtml })),
          [{ state: reviewState, bodyHtml: "" }],
        )
      }
    }),
  )

  it.live("submits a Review of each decision with no Drafts", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      for (const [decision, summary, reviewState] of [
        ["approve", "", "APPROVED"],
        ["request-changes", "Needs tests.", "CHANGES_REQUESTED"],
        ["comment", "Looks close.", "COMMENTED"],
      ] as const) {
        const pr = github.seedPullRequest({ base, head, changedFiles })

        const { pullRequest, revision } = yield* client.OpenPullRequest({
          pullRequest: new PullRequestRef(pr),
        })

        yield* client.SubmitReview({ pullRequestId: pullRequest.id, revision, decision, summary })

        assert.deepStrictEqual(viewerCommentsByLine(pr), [])
        assert.deepStrictEqual(
          pr.reviews.map(({ state, bodyHtml }) => ({ state, bodyHtml })),
          [{ state: reviewState, bodyHtml: summary === "" ? "" : `<p>${summary}</p>` }],
        )
      }
    }),
  )

  it.live("publishes Flagged drafts where they were written, along with the rest", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest(withDrafts)
      const [changed, kept] = pr.pendingReview!.drafts

      pr.push({
        head: { sha: "h2", files: { "greet.ts": "hello\nthere you\nworld\n" } },
        outdatedDrafts: [changed!.id],
      })

      const { pullRequest, revision } = yield* client.OpenPullRequest({
        pullRequest: new PullRequestRef(pr),
      })

      yield* client.SubmitReview({
        pullRequestId: pullRequest.id,
        revision,
        decision: "comment",
        summary: "",
      })

      assert.deepStrictEqual(
        pr.reviewThreads.map(({ comments, outdated }) => [comments[0]?.id, outdated]),
        [
          [changed!.id, true],
          [kept!.id, false],
        ],
      )
    }),
  )

  it.live("refuses a Review once the PR's head or base has moved, keeping every Draft", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      for (const push of [
        { head: { sha: "h2", files: head.files } },
        { base: { sha: "b1", files: base.files } },
      ]) {
        const pr = github.seedPullRequest(withDrafts)
        const drafts = pr.pendingReview!.drafts.slice()

        const { pullRequest, revision } = yield* client.OpenPullRequest({
          pullRequest: new PullRequestRef(pr),
        })

        pr.push(push)

        const error = yield* client
          .SubmitReview({
            pullRequestId: pullRequest.id,
            revision,
            decision: "approve",
            summary: "",
          })
          .pipe(Effect.flip)

        assert.deepStrictEqual(error, new StaleRevision())
        assert.deepStrictEqual(
          pr.pendingReview?.drafts.map(({ id, body }) => [id, body]),
          drafts.map(({ id, body }) => [id, body]),
        )
        assert.deepStrictEqual(pr.reviews, [])
      }
    }),
  )

  it.live("keeps every Draft when GitHub refuses the Review, as on the user's own PR", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ ...withDrafts, author: VIEWER.login })
      const drafts = pr.pendingReview!.drafts.slice()

      const { pullRequest, revision } = yield* client.OpenPullRequest({
        pullRequest: new PullRequestRef(pr),
      })

      const error = yield* client
        .SubmitReview({ pullRequestId: pullRequest.id, revision, decision: "approve", summary: "" })
        .pipe(Effect.flip)

      assert.isTrue(pullRequest.viewerIsAuthor)
      assert.deepStrictEqual(
        error,
        new ReviewRejected({ message: "Can not approve your own pull request" }),
      )
      assert.deepStrictEqual(pr.pendingReview?.drafts, drafts)
      assert.deepStrictEqual(pr.reviews, [])
    }),
  )
})
