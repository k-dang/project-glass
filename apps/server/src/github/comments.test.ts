import { assert, describe, it } from "@effect/vitest"
import {
  LineReviewThread,
  OutdatedReviewThread,
  PublishedComment,
  PullRequestRef,
  Review,
  type ReviewState,
} from "@glass/contracts"
import { DateTime, Effect } from "effect"
import { avatarUrl } from "../../test/fakeNodes"
import type { FakeComment, FakeReview } from "../../test/fakePullRequest"
import { startSignedInBackend } from "../../test/harness"

const base = { sha: "b0", files: { "greet.ts": "hello\nworld\n" } }

const head = { sha: "h1", files: { "greet.ts": "hello\nthere\nworld\n", "logo.png": "\u0000" } }

const changedFiles = [
  {
    path: "greet.ts",
    status: "modified",
    additions: 1,
    patch: "@@ -1,2 +1,3 @@\n hello\n+there\n world",
  },
  { path: "logo.png", status: "added" },
] as const

const published = (comment: FakeComment) =>
  new PublishedComment({
    id: comment.id,
    author: comment.author ?? "ghost",
    avatarUrl: comment.author === null ? null : avatarUrl(comment.author),
    bodyHtml: comment.bodyHtml,
    createdAt: DateTime.makeUnsafe(comment.createdAt),
    reactions: [],
  })

const review = (fake: FakeReview, state: ReviewState) =>
  new Review({
    id: fake.id,
    author: fake.author ?? "ghost",
    state,
    bodyHtml: fake.bodyHtml,
    submittedAt: DateTime.makeUnsafe(fake.submittedAt),
  })

describe("Review threads and the timeline", () => {
  it.live("places Review threads on their lines, each with its resolved state", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head, changedFiles })

      const open = pr.addReviewThread({
        path: "greet.ts",
        line: 2,
        side: "RIGHT",
        comments: [
          { author: "hubot", bodyHtml: "<p>Why <code>there</code>?</p>" },
          { author: null, bodyHtml: "<p>Because.</p>" },
        ],
      })

      const resolved = pr.addReviewThread({
        path: "greet.ts",
        line: 2,
        side: "LEFT",
        resolved: true,
        comments: [{ author: "hubot", bodyHtml: "<p>Gone?</p>" }],
      })

      const { lineReviewThreads, outdatedReviewThreads } = yield* client.LoadPullRequest({
        pullRequest: new PullRequestRef(pr),
      })

      assert.deepStrictEqual(lineReviewThreads, [
        new LineReviewThread({
          id: open.id,
          path: "greet.ts",
          side: "new",
          line: 2,
          resolved: false,
          comments: [published(open.comments[0]!), published(open.comments[1]!)],
        }),
        new LineReviewThread({
          id: resolved.id,
          path: "greet.ts",
          side: "old",
          line: 2,
          resolved: true,
          comments: [published(resolved.comments[0]!)],
        }),
      ])
      assert.deepStrictEqual(outdatedReviewThreads, [])
    }),
  )

  it.live("lists outdated and whole-file Review threads apart from the diff", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head, changedFiles })

      const outdated = pr.addReviewThread({
        path: "greet.ts",
        line: 2,
        side: "RIGHT",
        diffHunk: "@@ -1,2 +1,3 @@\n hello\n+there",
        comments: [{ author: "hubot", bodyHtml: "<p>Typo</p>" }],
      })

      const wholeFile = pr.addReviewThread({
        path: "logo.png",
        comments: [{ author: "hubot", bodyHtml: "<p>Too big</p>" }],
      })

      pr.push({ head: { sha: "h2", files: head.files }, outdatedReviewThreads: [outdated.id] })

      const { lineReviewThreads, outdatedReviewThreads } = yield* client.LoadPullRequest({
        pullRequest: new PullRequestRef(pr),
      })

      assert.deepStrictEqual(lineReviewThreads, [])
      assert.deepStrictEqual(outdatedReviewThreads, [
        new OutdatedReviewThread({
          id: outdated.id,
          path: "greet.ts",
          originalLine: 2,
          diffHunk: "@@ -1,2 +1,3 @@\n hello\n+there",
          resolved: false,
          comments: [published(outdated.comments[0]!)],
        }),
        new OutdatedReviewThread({
          id: wholeFile.id,
          path: "logo.png",
          originalLine: "whole-file",
          diffHunk: "",
          resolved: false,
          comments: [published(wholeFile.comments[0]!)],
        }),
      ])
    }),
  )

  it.live("lists Review threads in a file whose diff isn't shown apart from the diff", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      const pr = github.seedPullRequest({
        base,
        head,
        changedFiles: [{ path: "greet.ts", status: "modified", additions: 1 }],
      })

      const reviewThread = pr.addReviewThread({
        path: "greet.ts",
        line: 2,
        side: "RIGHT",
        diffHunk: "@@ -1,2 +1,3 @@\n hello\n+there",
        comments: [{ author: "hubot", bodyHtml: "<p>Typo</p>" }],
      })

      const { lineReviewThreads, outdatedReviewThreads } = yield* client.LoadPullRequest({
        pullRequest: new PullRequestRef(pr),
      })

      assert.deepStrictEqual(lineReviewThreads, [])
      assert.deepStrictEqual(outdatedReviewThreads, [
        new OutdatedReviewThread({
          id: reviewThread.id,
          path: "greet.ts",
          originalLine: 2,
          diffHunk: "@@ -1,2 +1,3 @@\n hello\n+there",
          resolved: false,
          comments: [published(reviewThread.comments[0]!)],
        }),
      ])
    }),
  )

  it.live("shows comments on the PR and submitted Reviews with their decisions, oldest first", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head, changedFiles })

      const comment = pr.addComment({ author: "hubot", bodyHtml: "<p>Thanks!</p>" })
      const approved = pr.addReview({ author: "hubot", state: "APPROVED" })
      const followUp = pr.addComment({ author: "hubot", bodyHtml: "<p>One more thought</p>" })

      const changes = pr.addReview({
        author: null,
        state: "CHANGES_REQUESTED",
        bodyHtml: "<p>Needs tests</p>",
      })

      const commented = pr.addReview({ author: "hubot", state: "COMMENTED", bodyHtml: "<p>Hm</p>" })
      const lastComment = pr.addComment({ author: "hubot", bodyHtml: "<p>Updated</p>" })
      const dismissed = pr.addReview({ author: "hubot", state: "DISMISSED" })
      pr.addReview({ author: "hubot", state: "COMMENTED" })

      const { timeline } = yield* client.LoadPullRequest({
        pullRequest: new PullRequestRef(pr),
      })

      assert.deepStrictEqual(timeline, [
        published(comment),
        review(approved, "approve"),
        published(followUp),
        review(changes, "request-changes"),
        review(commented, "comment"),
        published(lastComment),
        review(dismissed, "dismissed"),
      ])
    }),
  )

  it.live("leaves the viewer's Drafts and pending review out", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      const pr = github.seedPullRequest({
        base,
        head,
        changedFiles,
        pendingReview: {
          drafts: [{ path: "greet.ts", line: 2, side: "RIGHT", body: "Draft", diffHunk: "@@" }],
        },
      })

      const outdatedDraft = pr.addDraft({
        path: "greet.ts",
        line: 2,
        side: "RIGHT",
        body: "Outdated Draft",
        diffHunk: "@@",
      })

      pr.push({ head: { sha: "h2", files: head.files }, outdatedDrafts: [outdatedDraft.id] })

      const { lineReviewThreads, outdatedReviewThreads, timeline } = yield* client.LoadPullRequest({
        pullRequest: new PullRequestRef(pr),
      })

      assert.deepStrictEqual(lineReviewThreads, [])
      assert.deepStrictEqual(outdatedReviewThreads, [])
      assert.deepStrictEqual(timeline, [])
    }),
  )

  it.live("reads every page of a PR's Review threads", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head, changedFiles })
      const expectedOnLines: Array<LineReviewThread> = []
      const expectedTimeline: Array<PublishedComment | Review> = []

      for (let index = 0; index < 101; index++) {
        const reviewThread = pr.addReviewThread({
          path: "greet.ts",
          line: 2,
          side: "RIGHT",
          comments: [{ author: "hubot", bodyHtml: `<p>Thread ${index}</p>` }],
        })

        expectedOnLines.push(
          new LineReviewThread({
            id: reviewThread.id,
            path: "greet.ts",
            side: "new",
            line: 2,
            resolved: false,
            comments: [published(reviewThread.comments[0]!)],
          }),
        )
        const comment = pr.addComment({ author: "hubot", bodyHtml: `<p>Comment ${index}</p>` })

        const submittedReview = pr.addReview({
          author: "hubot",
          state: "COMMENTED",
          bodyHtml: `<p>Review ${index}</p>`,
        })

        expectedTimeline.push(published(comment), review(submittedReview, "comment"))
      }

      const { lineReviewThreads, timeline } = yield* client.LoadPullRequest({
        pullRequest: new PullRequestRef(pr),
      })

      assert.deepStrictEqual(lineReviewThreads, expectedOnLines)
      assert.deepStrictEqual(timeline, expectedTimeline)
    }),
  )
})
