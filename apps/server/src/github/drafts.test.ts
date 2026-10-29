import { assert, describe, it } from "@effect/vitest"
import {
  type DiffSide,
  Draft,
  DraftNotFound,
  FlaggedPlace,
  LinePlace,
  PullRequestRef,
  StaleRevision,
} from "@glass/contracts"
import { Effect } from "effect"
import { startSignedInBackend } from "../../test/harness"

const base = { sha: "b0", files: { "greet.ts": "hello\nworld\n", "logo.png": "\u0000" } }

const head = {
  sha: "h1",
  files: { "greet.ts": "hello\nthere\nworld\n", "logo.png": "\u0001\u0000" },
}

const patch = "@@ -1,2 +1,3 @@\n hello\n+there\n world"

const changedFiles = [
  { path: "greet.ts", status: "modified", additions: 1, patch },
  { path: "logo.png", status: "modified" },
] as const

const greetDraft = (id: string, side: DiffSide, line: number, body: string) =>
  new Draft({ id, path: "greet.ts", place: LinePlace.make({ side, line }), body })

describe("Drafts", () => {
  it.live("creates the pending review on the first Draft and adds later ones to it", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head, changedFiles })

      const { pullRequest, revision } = yield* client.OpenPullRequest({
        pullRequest: new PullRequestRef(pr),
      })

      const at = { pullRequestId: pullRequest.id, revision, path: "greet.ts" }

      const added = yield* client.CreateDraft({ ...at, side: "new", line: 2, body: "Why?" })
      const removed = yield* client.CreateDraft({ ...at, side: "old", line: 1, body: "Was" })

      assert.deepStrictEqual(added, greetDraft(added.id, "new", 2, "Why?"))
      assert.deepStrictEqual(removed, greetDraft(removed.id, "old", 1, "Was"))
      assert.deepStrictEqual(
        pr.pendingReview?.drafts.map(({ id, side, line, body }) => ({ id, side, line, body })),
        [
          { id: added.id, side: "RIGHT", line: 2, body: "Why?" },
          { id: removed.id, side: "LEFT", line: 1, body: "Was" },
        ],
      )

      const reopened = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.deepStrictEqual(reopened.drafts, [added, removed])
    }),
  )

  it.live("adopts a pending review that already exists, its comments loading as Drafts", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      const pr = github.seedPullRequest({
        base,
        head,
        changedFiles,
        pendingReview: {
          drafts: [{ path: "greet.ts", line: 2, side: "RIGHT", body: "Earlier", diffHunk: patch }],
        },
      })

      const pendingReviewId = pr.pendingReview?.id
      const earlier = pr.pendingReview!.drafts[0]!

      const { pullRequest, revision, drafts } = yield* client.OpenPullRequest({
        pullRequest: new PullRequestRef(pr),
      })

      assert.deepStrictEqual(drafts, [greetDraft(earlier.id, "new", 2, "Earlier")])

      yield* client.CreateDraft({
        pullRequestId: pullRequest.id,
        revision,
        path: "greet.ts",
        side: "new",
        line: 3,
        body: "Later",
      })

      assert.strictEqual(pr.pendingReview?.id, pendingReviewId)
      assert.deepStrictEqual(
        pr.pendingReview?.drafts.map((draft) => draft.body),
        ["Earlier", "Later"],
      )
    }),
  )

  it.live("refuses a Draft once the PR has moved past the workspace's Revision", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head, changedFiles })

      const { pullRequest, revision } = yield* client.OpenPullRequest({
        pullRequest: new PullRequestRef(pr),
      })

      pr.push({ head: { sha: "h2", files: head.files } })

      const error = yield* client
        .CreateDraft({
          pullRequestId: pullRequest.id,
          revision,
          path: "greet.ts",
          side: "new",
          line: 2,
          body: "Why?",
        })
        .pipe(Effect.flip)

      assert.deepStrictEqual(error, new StaleRevision())
      assert.strictEqual(pr.pendingReview, undefined)
    }),
  )

  it.live("saves a Draft's new body", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      const pr = github.seedPullRequest({
        base,
        head,
        changedFiles,
        pendingReview: {
          drafts: [{ path: "greet.ts", line: 2, side: "RIGHT", body: "Typo", diffHunk: patch }],
        },
      })

      const { id } = pr.pendingReview!.drafts[0]!
      yield* client.UpdateDraft({ id, body: "Typo: thier" })

      assert.strictEqual(pr.pendingReview?.drafts[0]?.body, "Typo: thier")
    }),
  )

  it.live("fails to update a Draft that's gone from GitHub", () =>
    Effect.gen(function* () {
      const { client } = yield* startSignedInBackend

      const error = yield* client.UpdateDraft({ id: "PRRC_gone", body: "Hm" }).pipe(Effect.flip)

      assert.deepStrictEqual(error, new DraftNotFound({ id: "PRRC_gone" }))
    }),
  )

  it.live("leaves a Draft alone once its Review is submitted elsewhere", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      const pr = github.seedPullRequest({
        base,
        head,
        changedFiles,
        pendingReview: {
          drafts: [{ path: "greet.ts", line: 2, side: "RIGHT", body: "Why?", diffHunk: patch }],
        },
      })

      const { id } = pr.pendingReview!.drafts[0]!
      pr.submitPendingReview()

      const error = yield* client.UpdateDraft({ id, body: "Why not?" }).pipe(Effect.flip)
      yield* client.DeleteDraft({ id })

      assert.deepStrictEqual(error, new DraftNotFound({ id }))
      assert.deepStrictEqual(
        pr.reviewThreads.flatMap((thread) => thread.comments.map((comment) => comment.bodyHtml)),
        ["<p>Why?</p>"],
      )
    }),
  )

  it.live(
    "deletes Drafts, the last one taking the pending review with it, and one already gone",
    () =>
      Effect.gen(function* () {
        const { github, client } = yield* startSignedInBackend

        const pr = github.seedPullRequest({
          base,
          head,
          changedFiles,
          pendingReview: {
            drafts: [
              { path: "greet.ts", line: 1, side: "RIGHT", body: "One", diffHunk: patch },
              { path: "greet.ts", line: 2, side: "RIGHT", body: "Two", diffHunk: patch },
            ],
          },
        })

        const [one, two] = pr.pendingReview!.drafts

        yield* client.DeleteDraft({ id: one!.id })
        assert.deepStrictEqual(
          pr.pendingReview?.drafts.map((draft) => draft.id),
          [two!.id],
        )

        yield* client.DeleteDraft({ id: two!.id })
        assert.strictEqual(pr.pendingReview, undefined)

        yield* client.DeleteDraft({ id: two!.id })
      }),
  )

  it.live("flags Drafts GitHub reports outdated after a push, with the hunk they were on", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head, changedFiles })

      const { pullRequest, revision } = yield* client.OpenPullRequest({
        pullRequest: new PullRequestRef(pr),
      })

      const at = { pullRequestId: pullRequest.id, revision, path: "greet.ts", side: "new" } as const

      const changed = yield* client.CreateDraft({ ...at, line: 2, body: "Why?" })
      const kept = yield* client.CreateDraft({ ...at, line: 3, body: "Fine" })

      pr.push({
        head: { sha: "h2", files: { ...head.files, "greet.ts": "hello\nthere you\nworld\n" } },
        outdatedDrafts: [changed.id],
      })

      const { drafts } = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.deepStrictEqual(drafts, [
        new Draft({
          id: changed.id,
          path: "greet.ts",
          place: FlaggedPlace.make({ originalLine: 2, diffHunk: patch }),
          body: "Why?",
        }),
        kept,
      ])
    }),
  )

  it.live("flags a Draft in a file whose diff isn't shown", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      const pr = github.seedPullRequest({
        base,
        head,
        changedFiles,
        pendingReview: {
          drafts: [{ path: "logo.png", line: 1, side: "RIGHT", body: "Big", diffHunk: "" }],
        },
      })

      const { drafts } = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.deepStrictEqual(
        drafts.map(({ path, place }) => [path, place]),
        [["logo.png", FlaggedPlace.make({ originalLine: 1, diffHunk: "" })]],
      )
    }),
  )
})
