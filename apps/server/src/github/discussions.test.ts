import { assert, describe, it } from "@effect/vitest"
import {
  LineDiscussion,
  OutdatedDiscussion,
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
  })

const review = (fake: FakeReview, state: ReviewState) =>
  new Review({
    id: fake.id,
    author: fake.author ?? "ghost",
    state,
    bodyHtml: fake.bodyHtml,
    submittedAt: DateTime.makeUnsafe(fake.submittedAt),
  })

describe("Discussions", () => {
  it.live("places Discussions on their lines, each with its resolved state", () =>
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

      const { discussions } = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.deepStrictEqual(discussions.onLines, [
        new LineDiscussion({
          id: open.id,
          path: "greet.ts",
          side: "new",
          line: 2,
          resolved: false,
          comments: [published(open.comments[0]!), published(open.comments[1]!)],
        }),
        new LineDiscussion({
          id: resolved.id,
          path: "greet.ts",
          side: "old",
          line: 2,
          resolved: true,
          comments: [published(resolved.comments[0]!)],
        }),
      ])
      assert.deepStrictEqual(discussions.outdated, [])
    }),
  )

  it.live("lists outdated and whole-file Discussions apart from the diff", () =>
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

      pr.push({ head: { sha: "h2", files: head.files }, outdatedThreads: [outdated.id] })

      const { discussions } = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.deepStrictEqual(discussions.onLines, [])
      assert.deepStrictEqual(discussions.outdated, [
        new OutdatedDiscussion({
          id: outdated.id,
          path: "greet.ts",
          originalLine: 2,
          diffHunk: "@@ -1,2 +1,3 @@\n hello\n+there",
          resolved: false,
          comments: [published(outdated.comments[0]!)],
        }),
        new OutdatedDiscussion({
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

  it.live("lists Discussions in a file whose diff isn't shown apart from the diff", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      const pr = github.seedPullRequest({
        base,
        head,
        changedFiles: [{ path: "greet.ts", status: "modified", additions: 1 }],
      })

      const thread = pr.addReviewThread({
        path: "greet.ts",
        line: 2,
        side: "RIGHT",
        diffHunk: "@@ -1,2 +1,3 @@\n hello\n+there",
        comments: [{ author: "hubot", bodyHtml: "<p>Typo</p>" }],
      })

      const { discussions } = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.deepStrictEqual(discussions.onLines, [])
      assert.deepStrictEqual(discussions.outdated, [
        new OutdatedDiscussion({
          id: thread.id,
          path: "greet.ts",
          originalLine: 2,
          diffHunk: "@@ -1,2 +1,3 @@\n hello\n+there",
          resolved: false,
          comments: [published(thread.comments[0]!)],
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

      const { discussions } = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.deepStrictEqual(discussions.timeline, [
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

      const { discussions } = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.deepStrictEqual(discussions.onLines, [])
      assert.deepStrictEqual(discussions.outdated, [])
      assert.deepStrictEqual(discussions.timeline, [])
    }),
  )

  it.live("reads every page of a PR's Discussions", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head, changedFiles })
      const expectedOnLines: Array<LineDiscussion> = []
      const expectedTimeline: Array<PublishedComment | Review> = []

      for (let index = 0; index < 101; index++) {
        const thread = pr.addReviewThread({
          path: "greet.ts",
          line: 2,
          side: "RIGHT",
          comments: [{ author: "hubot", bodyHtml: `<p>Thread ${index}</p>` }],
        })

        expectedOnLines.push(
          new LineDiscussion({
            id: thread.id,
            path: "greet.ts",
            side: "new",
            line: 2,
            resolved: false,
            comments: [published(thread.comments[0]!)],
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

      const { discussions } = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.deepStrictEqual(discussions.onLines, expectedOnLines)
      assert.deepStrictEqual(discussions.timeline, expectedTimeline)
    }),
  )
})
