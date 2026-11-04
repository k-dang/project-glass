import { assert, describe, it } from "@effect/vitest"
import { CommentNotFound, PublishedComment, PullRequestRef, ReactionGroup } from "@glass/contracts"
import { Effect } from "effect"
import { startSignedInBackend } from "../../test/harness"
import { VIEWER } from "../../test/fakePullRequest"
import { toReactionGroups } from "./reactions"

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

describe("Reactions", () => {
  it.live("adds and removes the viewer's Reaction beside others' on a Discussion comment", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head, changedFiles })
      const commentId = pr.addReviewThread(thread).comments[0]!.id
      pr.react(commentId, "THUMBS_UP", "hubot")

      const open = Effect.map(
        client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) }),
        (workspace) => workspace.discussions.onLines[0]?.comments[0].reactions,
      )

      assert.deepStrictEqual(yield* open, [
        new ReactionGroup({ reaction: "thumbs-up", count: 1, reacted: false }),
      ])

      const added = yield* client.SetReaction({ commentId, reaction: "thumbs-up", reacted: true })
      const both = [new ReactionGroup({ reaction: "thumbs-up", count: 2, reacted: true })]

      assert.deepStrictEqual(added, both)
      assert.deepStrictEqual(yield* open, both)

      assert.deepStrictEqual(
        yield* client.SetReaction({ commentId, reaction: "thumbs-up", reacted: false }),
        [new ReactionGroup({ reaction: "thumbs-up", count: 1, reacted: false })],
      )
      assert.isFalse(pr.reactions.get(commentId)?.get("THUMBS_UP")?.has(VIEWER.login))
    }),
  )

  it.live("reacts to a comment on the PR itself", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head, changedFiles })
      const comment = pr.addComment({ author: "hubot", bodyHtml: "<p>Ship it</p>" })

      yield* client.SetReaction({ commentId: comment.id, reaction: "rocket", reacted: true })

      const { timeline } = (yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) }))
        .discussions

      assert.deepStrictEqual(timeline.find((item) => item instanceof PublishedComment)?.reactions, [
        new ReactionGroup({ reaction: "rocket", count: 1, reacted: true }),
      ])
    }),
  )

  it.live("fails a comment that's gone", () =>
    Effect.gen(function* () {
      const { client } = yield* startSignedInBackend

      assert.deepStrictEqual(
        yield* client
          .SetReaction({ commentId: "IC_gone", reaction: "heart", reacted: true })
          .pipe(Effect.flip),
        new CommentNotFound({ id: "IC_gone" }),
      )
    }),
  )

  it("skips a Reaction GitHub added after Glass's mapping", () => {
    assert.deepStrictEqual(
      toReactionGroups([
        { content: "SPARKLES", reactors: { totalCount: 1 }, viewerHasReacted: false },
        { content: "EYES", reactors: { totalCount: 2 }, viewerHasReacted: true },
      ]),
      [new ReactionGroup({ reaction: "eyes", count: 2, reacted: true })],
    )
  })
})
