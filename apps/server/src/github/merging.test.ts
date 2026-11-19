import { assert, describe, it } from "@effect/vitest"
import {
  AddToMergeQueue,
  AddToMergeQueueWhenReady,
  CanAddToMergeQueue,
  CanAddToMergeQueueWhenReady,
  CanMerge,
  CanMergeWhenReady,
  Merge,
  MergeRejected,
  MergeWhenReady,
  PullRequestRef,
  StaleRevision,
} from "@glass/contracts"
import { Effect } from "effect"
import type { FakePullRequestSeed } from "../../test/fakePullRequest"
import { startSignedInBackend } from "../../test/harness"

const base = { sha: "b0", files: { "greet.ts": "hello\n" } }

const head = { sha: "h1", files: { "greet.ts": "hello\nworld\n" } }

describe("Merging", () => {
  it.live("offers what GitHub would do with the PR now", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      for (const [seed, expected] of [
        [{}, CanMerge.make({ methods: ["merge", "squash", "rebase"] })],
        [{ mergeMethods: ["REBASE", "SQUASH"] }, CanMerge.make({ methods: ["rebase", "squash"] })],
        [
          { mergeStateStatus: "UNSTABLE" },
          CanMerge.make({ methods: ["merge", "squash", "rebase"] }),
        ],
        [
          { mergeStateStatus: "BLOCKED", mergeMethods: ["SQUASH"] },
          CanMergeWhenReady.make({ methods: ["squash"] }),
        ],
        [{ mergeQueue: true }, CanAddToMergeQueue.make({})],
        [{ mergeQueue: true, mergeStateStatus: "BEHIND" }, CanAddToMergeQueueWhenReady.make({})],
        [{ mergeStateStatus: "BLOCKED", viewerCanEnableAutoMerge: false }, null],
        [{ mergeStateStatus: "DIRTY" }, null],
        [{ mergeStateStatus: "UNKNOWN" }, null],
        [{ viewerPermission: "READ" }, null],
        [{ isDraft: true }, null],
        [{ state: "MERGED" }, null],
      ] satisfies ReadonlyArray<readonly [Partial<FakePullRequestSeed>, unknown]>) {
        const pr = github.seedPullRequest({ ...seed, base, head })

        const { pullRequest } = yield* client.LoadPullRequest({
          pullRequest: new PullRequestRef(pr),
        })

        assert.deepStrictEqual(
          [pullRequest.mergeOffer, pullRequest.mergeUnderWay],
          [expected, null],
          JSON.stringify(seed),
        )
      }
    }),
  )

  it.live("merges with the chosen method, then shows the PR merged", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head })
      const ref = new PullRequestRef(pr)
      const { pullRequest, revision } = yield* client.LoadPullRequest({ pullRequest: ref })

      yield* client.MergePullRequest({
        pullRequestId: pullRequest.id,
        revision,
        request: Merge.make({ method: "squash" }),
      })

      assert.strictEqual(pr.mergedWith, "SQUASH")

      const reloaded = (yield* client.LoadPullRequest({ pullRequest: ref })).pullRequest
      assert.deepStrictEqual(
        [reloaded.state, reloaded.mergeOffer, reloaded.mergeUnderWay],
        ["merged", null, null],
      )
    }),
  )

  it.live("turns on auto-merge or joins the merge queue, and shows it under way", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      for (const [seed, request, expected] of [
        [{ mergeStateStatus: "BLOCKED" }, MergeWhenReady.make({ method: "rebase" }), "auto-merge"],
        [{ mergeQueue: true }, AddToMergeQueue.make({}), "merge-queue"],
        [
          { mergeQueue: true, mergeStateStatus: "BLOCKED" },
          AddToMergeQueueWhenReady.make({}),
          "auto-merge",
        ],
      ] as const) {
        const pr = github.seedPullRequest({ ...seed, base, head })
        const ref = new PullRequestRef(pr)
        const { pullRequest, revision } = yield* client.LoadPullRequest({ pullRequest: ref })

        yield* client.MergePullRequest({ pullRequestId: pullRequest.id, revision, request })

        const reloaded = (yield* client.LoadPullRequest({ pullRequest: ref })).pullRequest
        assert.deepStrictEqual(
          [reloaded.state, reloaded.mergeOffer, reloaded.mergeUnderWay],
          ["open", null, expected],
        )
      }
    }),
  )

  it.live("refuses to merge once the PR has new commits", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head })

      const { pullRequest, revision } = yield* client.LoadPullRequest({
        pullRequest: new PullRequestRef(pr),
      })

      pr.push({ head: { sha: "h2", files: head.files } })

      const error = yield* client
        .MergePullRequest({
          pullRequestId: pullRequest.id,
          revision,
          request: Merge.make({ method: "merge" }),
        })
        .pipe(Effect.flip)

      assert.deepStrictEqual([error, pr.state], [new StaleRevision(), "OPEN"])
    }),
  )

  it.live("passes on GitHub's reason when it won't merge", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ mergeStateStatus: "BLOCKED", base, head })

      const { pullRequest, revision } = yield* client.LoadPullRequest({
        pullRequest: new PullRequestRef(pr),
      })

      const error = yield* client
        .MergePullRequest({
          pullRequestId: pullRequest.id,
          revision,
          request: Merge.make({ method: "merge" }),
        })
        .pipe(Effect.flip)

      assert.deepStrictEqual(error, new MergeRejected({ message: "Pull request is not mergeable" }))
    }),
  )
})
