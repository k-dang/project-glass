import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { GitHubDiffSide } from "../src/github/diffSide"
import { AddedDraft, ADD_DRAFT_MUTATION } from "../src/github/drafts"
import { startFakeGitHub } from "./fakeGitHub"
import { VIEWER } from "./fakePullRequest"

const addDraft = Effect.fnUntraced(function* (
  url: string,
  pullRequestId: string,
  path: string,
  side: typeof GitHubDiffSide.Type,
  line: number,
) {
  const response = yield* Effect.promise(() =>
    fetch(`${url}/graphql`, {
      method: "POST",
      headers: { authorization: `Bearer ${VIEWER.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        operationName: "AddPullRequestReviewThread",
        query: ADD_DRAFT_MUTATION,
        variables: { pullRequestId, path, side, line, body: "Why?" },
      }),
    }),
  )

  assert.strictEqual(response.status, 200)
  const body = yield* Effect.promise(() => response.text())

  const result = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        data: AddedDraft,
        errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
      }),
    ),
  )(body)

  assert.strictEqual(result.errors, undefined)

  return result.data.addPullRequestReviewThread?.thread
})

const base = {
  sha: "b0",
  files: { "greet.ts": "one\nkeep\nbefore\nfour\nfive\nsix\nseven\nold\nten\n" },
}

const head = {
  sha: "h1",
  files: { "greet.ts": "one\nkeep\nafter\nextra\nfour\nfive\nsix\nseven\nnew\nten\n" },
}

const patch = "@@ -2,2 +2,3 @@\n keep\n-before\n+after\n+extra\n@@ -8 +9 @@\n-old\n+new"

describe("fake GitHub Draft lines", () => {
  it.live(
    "rejects lines outside the requested side's hunks without creating a pending review",
    () =>
      Effect.gen(function* () {
        const github = yield* startFakeGitHub()

        const pr = github.seedPullRequest({
          base,
          head,
          changedFiles: [{ path: "greet.ts", status: "modified", patch }],
        })

        const rejected = [
          ["LEFT", 0],
          ["RIGHT", 0],
          ["LEFT", 1],
          ["RIGHT", 1],
          ["LEFT", 4],
          ["RIGHT", 5],
          ["LEFT", 7],
          ["RIGHT", 8],
          ["LEFT", 9],
          ["RIGHT", 10],
        ] as const

        for (const [side, line] of rejected) {
          const thread = yield* addDraft(github.url, pr.id, "greet.ts", side, line)

          assert.strictEqual(thread, null, `${side}:${line}`)
          assert.strictEqual(pr.pendingReview, undefined)
        }
      }),
  )

  it.live("accepts context on either side and changed lines through the end of later hunks", () =>
    Effect.gen(function* () {
      const github = yield* startFakeGitHub()

      const pr = github.seedPullRequest({
        base,
        head,
        changedFiles: [{ path: "greet.ts", status: "modified", patch }],
      })

      const accepted = [
        ["LEFT", 2],
        ["RIGHT", 2],
        ["LEFT", 3],
        ["RIGHT", 3],
        ["RIGHT", 4],
        ["LEFT", 8],
        ["RIGHT", 9],
      ] as const

      for (const [side, line] of accepted) {
        const thread = yield* addDraft(github.url, pr.id, "greet.ts", side, line)

        assert.deepStrictEqual(thread, {
          path: "greet.ts",
          line,
          diffSide: side,
          comments: { nodes: [{ id: pr.pendingReview!.drafts.at(-1)!.id, body: "Why?" }] },
        })
      }

      assert.strictEqual(pr.pendingReview?.drafts.length, accepted.length)
    }),
  )

  it.live("rejects the empty side of added and deleted files and preserves existing Drafts", () =>
    Effect.gen(function* () {
      const github = yield* startFakeGitHub()

      const pr = github.seedPullRequest({
        base: { sha: "b0", files: { "gone.ts": "old" } },
        head: { sha: "h1", files: { "new.ts": "new" } },
        changedFiles: [
          {
            path: "new.ts",
            status: "added",
            patch: "@@ -0,0 +1 @@\n+new\n\\ No newline at end of file",
          },
          { path: "gone.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-old" },
        ],
      })

      yield* addDraft(github.url, pr.id, "new.ts", "RIGHT", 1)
      yield* addDraft(github.url, pr.id, "gone.ts", "LEFT", 1)
      const pending = structuredClone(pr.pendingReview)

      for (const line of [0, 1]) {
        assert.strictEqual(yield* addDraft(github.url, pr.id, "new.ts", "LEFT", line), null)
        assert.strictEqual(yield* addDraft(github.url, pr.id, "gone.ts", "RIGHT", line), null)
      }

      assert.strictEqual(pending?.drafts.length, 2)
      assert.deepStrictEqual(pr.pendingReview, pending)
    }),
  )

  it.live("rejects files with no usable patch", () =>
    Effect.gen(function* () {
      const github = yield* startFakeGitHub()

      const pr = github.seedPullRequest({
        base,
        head,
        changedFiles: [
          { path: "binary.png", status: "modified" },
          { path: "greet.ts", status: "modified", patch: "@@" },
        ],
      })

      for (const path of ["binary.png", "greet.ts", "missing.ts"]) {
        assert.strictEqual(yield* addDraft(github.url, pr.id, path, "RIGHT", 2), null)
      }

      assert.strictEqual(pr.pendingReview, undefined)
    }),
  )
})
