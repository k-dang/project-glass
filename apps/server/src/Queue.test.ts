import { assert, it } from "@effect/vitest"
import { PullRequestRef, PullRequestSummary, type Queue } from "@glass/contracts"
import { DateTime, Effect } from "effect"
import { startFakeGitHub } from "../test/fakeGitHub"
import { type FakePullRequest, VIEWER } from "../test/fakePullRequest"
import { isolatedHome, startBackend } from "../test/harness"

const base = { sha: "b0", files: {} }

const head = { sha: "h1", files: {} }

const ref = (pr: FakePullRequest) =>
  new PullRequestRef({ owner: pr.owner, repo: pr.repo, number: pr.number })

const missing = (owner: string, repo: string, number: number) =>
  new PullRequestRef({ owner, repo, number })

const titles = (queue: Queue) => queue.map((queued) => queued.pullRequest.title)

const startSignedIn = Effect.gen(function* () {
  const github = yield* startFakeGitHub()
  const home = yield* isolatedHome
  const env = { GH_TOKEN: VIEWER.token, GLASS_GITHUB_API_URL: github.url }

  return { github, home, start: startBackend(env, home) }
})

it.live("queues PRs GitHub finds in the order added, once each, across restarts", () =>
  Effect.gen(function* () {
    const { github, start } = yield* startSignedIn

    const greet = github.seedPullRequest({
      owner: "octo-org",
      repo: "glass",
      title: "Greet the world",
      author: "hubot",
      checks: "FAILURE",
      updatedAt: "2026-03-01T10:00:00Z",
      base,
      head,
    })

    const wave = github.seedPullRequest({
      owner: "mona",
      repo: "elsewhere",
      title: "Wave",
      base,
      head,
    })

    const fibers = github.seedPullRequest({
      owner: "effect-ts",
      repo: "effect",
      title: "Fibers",
      base,
      head,
    })

    yield* Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* start
        assert.deepStrictEqual(yield* client.ListSavedQueue(), [])

        const first = yield* client.AddToQueue({
          references: [
            ref(greet),
            missing("octo-org", "glass", 999),
            missing("nobody", "nothing", 1),
          ],
        })

        assert.deepStrictEqual(first.added, [ref(greet)])
        assert.deepStrictEqual(first.alreadyQueued, [])
        assert.deepStrictEqual(first.notFound, [
          missing("octo-org", "glass", 999),
          missing("nobody", "nothing", 1),
        ])
        assert.deepStrictEqual(
          (yield* client.ListSavedQueue())[0]?.pullRequest,
          new PullRequestSummary({
            ref: ref(greet),
            url: greet.url,
            title: "Greet the world",
            author: "hubot",
            isDraft: false,
            checks: "failing",
            updatedAt: DateTime.makeUnsafe("2026-03-01T10:00:00Z"),
          }),
        )

        const shouted = missing("OCTO-ORG", "Glass", greet.number)
        const second = yield* client.AddToQueue({ references: [ref(wave), shouted, ref(fibers)] })

        assert.deepStrictEqual(second.added, [ref(wave), ref(fibers)])
        assert.deepStrictEqual(second.alreadyQueued, [shouted])
        assert.deepStrictEqual(titles(yield* client.ListSavedQueue()), [
          "Greet the world",
          "Wave",
          "Fibers",
        ])
      }),
    )

    const { client } = yield* start
    assert.deepStrictEqual(titles(yield* client.ListSavedQueue()), [
      "Greet the world",
      "Wave",
      "Fibers",
    ])
  }),
)

it.live("queues a PR after every one already queued, however soon after a big paste", () =>
  Effect.gen(function* () {
    const { github, start } = yield* startSignedIn

    const pasted = Array.from({ length: 200 }, (_, index) =>
      github.seedPullRequest({ title: `Pasted ${index}`, base, head }),
    )

    const later = github.seedPullRequest({ title: "Later", base, head })
    const { client } = yield* start
    yield* client.AddToQueue({ references: pasted.map(ref) })
    yield* client.AddToQueue({ references: [ref(later)] })

    assert.deepStrictEqual(titles(yield* client.ListSavedQueue()), [
      ...pasted.map((pr) => pr.title),
      "Later",
    ])
  }),
)

it.live("puts a removed PR back in its old place, even after more were added", () =>
  Effect.gen(function* () {
    const { github, start } = yield* startSignedIn

    const [greet, wave, fibers] = ["Greet", "Wave", "Fibers"].map((title) =>
      github.seedPullRequest({ title, base, head }),
    )

    const { client } = yield* start
    yield* client.AddToQueue({ references: [ref(greet!), ref(wave!)] })

    const removed = yield* client.RemoveFromQueue({ reference: ref(greet!) })
    assert.deepStrictEqual(titles(yield* client.ListSavedQueue()), ["Wave"])
    yield* client.AddToQueue({ references: [ref(fibers!)] })

    yield* client.RestoreToQueue({ queued: removed! })
    assert.deepStrictEqual(titles(yield* client.ListSavedQueue()), ["Greet", "Wave", "Fibers"])
  }),
)

it.live(
  "refreshes queued PRs from GitHub, keeping the last known row of one GitHub won't give",
  () =>
    Effect.gen(function* () {
      const { github, start } = yield* startSignedIn
      const merged = github.seedPullRequest({ owner: "octo-org", title: "Merge me", base, head })
      const closed = github.seedPullRequest({ owner: "octo-org", title: "Close me", base, head })
      const drafted = github.seedPullRequest({ owner: "octo-org", title: "Draft me", base, head })

      const locked = github.seedPullRequest({
        owner: "saml-org",
        repo: "secret",
        title: "Locked",
        base,
        head,
      })

      const { client } = yield* start
      yield* client.AddToQueue({ references: [merged, closed, drafted, locked].map(ref) })

      merged.edit({ state: "MERGED" })
      closed.edit({ state: "CLOSED" })
      drafted.edit({ isDraft: true })
      github.unavailableRepositories.add("saml-org/secret")

      yield* client.RefreshQueue()
      assert.deepStrictEqual(
        (yield* client.ListSavedQueue()).map(({ pullRequest, state, problem }) => [
          pullRequest.title,
          state,
          pullRequest.isDraft,
          problem !== null,
        ]),
        [
          ["Merge me", "merged", false, false],
          ["Close me", "closed", false, false],
          ["Draft me", "draft", true, false],
          ["Locked", "open", false, true],
        ],
      )
      github.unavailableRepositories.delete("saml-org/secret")
      yield* client.RefreshQueue()
      assert.deepStrictEqual(
        (yield* client.ListSavedQueue()).map(({ problem }) => problem),
        [null, null, null, null],
      )

      github.timingOutRepositories.add("saml-org/secret")
      const timedOut = yield* client.RefreshQueue().pipe(Effect.flip)
      assert.strictEqual(timedOut._tag, "GitHubUnavailable")
      assert.deepStrictEqual(
        (yield* client.ListSavedQueue()).map(({ problem }) => problem),
        [null, null, null, null],
      )
      github.timingOutRepositories.clear()

      github.failNext(502)
      const failure = yield* client.RefreshQueue().pipe(Effect.flip)
      assert.strictEqual(failure._tag, "GitHubUnavailable")
    }),
)

it.live(
  "marks PRs opened since they were queued, and takes a PR out once a Review is submitted",
  () =>
    Effect.gen(function* () {
      const { github, start } = yield* startSignedIn
      const earlier = github.seedPullRequest({ title: "Opened before queuing", base, head })
      const later = github.seedPullRequest({ title: "Opened after queuing", base, head })
      const { client } = yield* start
      yield* client.OpenPullRequest({ pullRequest: ref(earlier) })
      yield* client.AddToQueue({ references: [ref(earlier), ref(later)] })
      const opened = yield* client.OpenPullRequest({ pullRequest: ref(later) })

      assert.deepStrictEqual(
        (yield* client.ListSavedQueue()).map(({ pullRequest, openedSinceQueued }) => [
          pullRequest.title,
          openedSinceQueued,
        ]),
        [
          ["Opened before queuing", false],
          ["Opened after queuing", true],
        ],
      )

      yield* client.SubmitReview({
        pullRequestId: opened.pullRequest.id,
        revision: opened.revision,
        decision: "approve",
        summary: "",
      })
      assert.deepStrictEqual(titles(yield* client.ListSavedQueue()), ["Opened before queuing"])
    }),
)
