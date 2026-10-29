import { assert, describe, it } from "@effect/vitest"
import {
  Activity,
  ActivityLogError,
  ActivityPullRequest,
  ActivityToDo,
  Draft,
  FileViewed,
  FollowedRepository,
  GitHubUnavailable,
  LinePlace,
  type PullRequestListings,
  PullRequestOpened,
  PullRequestRef,
  ReplySent,
  RepositoryPullRequests,
  ReviewSubmitted,
  Revision,
  ToDoAdded,
  ToDoDone,
} from "@glass/contracts"
import { DateTime, Effect, Match, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { startFakeGitHub } from "../test/fakeGitHub"
import { VIEWER } from "../test/fakePullRequest"
import { isolatedHome, startBackend } from "../test/harness"

const pullRequest = new ActivityPullRequest({
  ref: new PullRequestRef({ owner: "acme", repo: "api", number: 42 }),
  title: "Greet them warmly",
  revision: new Revision({ base: "b0", head: "h1" }),
})

const opened = PullRequestOpened.make({ pullRequest })

const viewed = (path: string) => FileViewed.make({ pullRequest, path })

const decodeActivity = Schema.decodeUnknownSync(Schema.fromJsonString(Activity))

const encodeActivity = Schema.encodeSync(Activity)

const startSignedInBackend = Effect.fnUntraced(function* (home: string) {
  const github = yield* startFakeGitHub()

  return yield* startBackend({ GH_TOKEN: VIEWER.token, GLASS_GITHUB_API_URL: github.url }, home)
})

const reviewingNumbers = (listings: PullRequestListings) =>
  listings.reviewingProblem === null
    ? listings.reviewing.flatMap((group) =>
        Match.valueTags(group, {
          RepositoryPullRequests: ({ pullRequests }) => pullRequests.map((pr) => pr.ref.number),
          RepositoryUnavailable: ({ error }) => assert.fail(error.message),
        }),
      )
    : assert.fail(listings.reviewingProblem.message)

const readLog = (home: string) => {
  const database = new DatabaseSync(join(home, ".project-glass", "glass.db"), { readOnly: true })

  try {
    return database
      .prepare("SELECT kind, payload, occurred_at, login FROM activity ORDER BY id")
      .all()
      .map((row) => ({
        kind: row["kind"],
        activity: decodeActivity(row["payload"]),
        occurredAt: DateTime.makeUnsafe(String(row["occurred_at"])),
        login: row["login"],
      }))
  } finally {
    database.close()
  }
}

describe("Activity log", () => {
  it.live("records successful PR opens and reloads before returning, excluding failed opens", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const github = yield* startFakeGitHub()

      const pr = github.seedPullRequest({
        owner: "acme",
        repo: "api",
        number: 42,
        title: pullRequest.title,
        base: { sha: "b0", files: {} },
        head: { sha: "h1", files: {} },
      })

      const { client } = yield* startBackend(
        { GH_TOKEN: VIEWER.token, GLASS_GITHUB_API_URL: github.url },
        home,
      )

      yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })
      assert.deepStrictEqual(
        readLog(home).map(({ activity }) => activity),
        [opened],
      )

      pr.push({ head: { sha: "h2", files: {} } })
      yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })
      assert.deepStrictEqual(
        readLog(home).map(({ activity }) => activity),
        [
          opened,
          PullRequestOpened.make({
            pullRequest: new ActivityPullRequest({
              ref: pullRequest.ref,
              title: pullRequest.title,
              revision: new Revision({ base: "b0", head: "h2" }),
            }),
          }),
        ],
      )

      github.failNext(503)
      assert.instanceOf(
        yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) }).pipe(Effect.flip),
        GitHubUnavailable,
      )
      assert.strictEqual(readLog(home).length, 2)
    }),
  )

  it.live("keeps a successful PR open usable when recording its Activity fails", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const github = yield* startFakeGitHub()

      const pr = github.seedPullRequest({
        base: { sha: "b0", files: {} },
        head: { sha: "h1", files: {} },
      })

      const { client } = yield* startBackend(
        { GH_TOKEN: VIEWER.token, GLASS_GITHUB_API_URL: github.url },
        home,
      )

      github.beforeNext("/user", () => github.failNext(503))
      const workspace = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.strictEqual(workspace.pullRequest.url, pr.url)
      assert.isEmpty(readLog(home))

      yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })
      assert.strictEqual(readLog(home).length, 1)
    }),
  )

  it.live("records each kind of Activity as it was sent", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const { client } = yield* startSignedInBackend(home)

      const activities = [
        opened,
        viewed("greet.ts"),
        ReviewSubmitted.make({
          pullRequest,
          decision: "request-changes",
          summary: "Say hello first.",
          drafts: [
            new Draft({
              id: "PRRC_1",
              path: "greet.ts",
              place: LinePlace.make({ side: "new", line: 2 }),
              body: "Why?",
            }),
          ],
        }),
        ReplySent.make({ pullRequest, discussionId: "PRRT_1", body: "To greet them." }),
      ]

      for (const activity of activities) yield* client.RecordActivity(activity)

      const log = readLog(home)

      assert.deepStrictEqual(
        log.map(({ kind, activity }) => ({ kind, activity })),
        activities.map((activity) => ({ kind: activity._tag, activity })),
      )
    }),
  )

  it.live("stamps when each Activity happened and the Connection it was done as", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const { client } = yield* startSignedInBackend(home)
      const before = yield* DateTime.now

      yield* client.RecordActivity(opened)

      const after = yield* DateTime.now
      const entry = readLog(home)[0]!

      assert.strictEqual(entry.login, VIEWER.login)
      assert.isTrue(DateTime.between(entry.occurredAt, { minimum: before, maximum: after }))
    }),
  )

  it.live("lists the current Connection's Activity newest first, a page at a time", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const { client } = yield* startSignedInBackend(home)

      const activities = [opened, viewed("a.ts"), viewed("b.ts")]

      for (const activity of activities) yield* client.RecordActivity(activity)

      const database = new DatabaseSync(join(home, ".project-glass", "glass.db"))

      try {
        database
          .prepare("INSERT INTO activity (kind, payload, occurred_at, login) VALUES (?, ?, ?, ?)")
          .run(
            "PullRequestOpened",
            JSON.stringify(encodeActivity(opened)),
            new Date().toISOString(),
            "another-user",
          )
      } finally {
        database.close()
      }

      const firstPage = yield* client.ListActivity({ limit: 2 })
      const fullPage = yield* client.ListActivity({ limit: 3 })

      assert.deepStrictEqual(
        firstPage.activities.map(({ activity }) => activity),
        activities.toReversed().slice(0, 2),
      )
      assert.isTrue(firstPage.hasMore)
      assert.deepStrictEqual(
        fullPage.activities.map(({ activity }) => activity),
        activities.toReversed(),
      )
      assert.isFalse(fullPage.hasMore)
      assert.deepStrictEqual(
        fullPage.activities.map(({ occurredAt }) => occurredAt),
        readLog(home)
          .slice(0, 3)
          .toReversed()
          .map(({ occurredAt }) => occurredAt),
      )
    }),
  )

  it.live("skips an unreadable Activity and keeps listing the rest", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const { client } = yield* startSignedInBackend(home)
      yield* client.RecordActivity(opened)
      const database = new DatabaseSync(join(home, ".project-glass", "glass.db"))

      try {
        database
          .prepare("INSERT INTO activity (kind, payload, occurred_at, login) VALUES (?, ?, ?, ?)")
          .run("PullRequestOpened", "{}", new Date().toISOString(), VIEWER.login)
      } finally {
        database.close()
      }

      yield* client.RecordActivity(viewed("a.ts"))

      const page = yield* client.ListActivity({ limit: 2 })

      assert.deepStrictEqual(
        page.activities.map(({ activity }) => activity),
        [viewed("a.ts")],
      )
      assert.isTrue(page.hasMore)
    }),
  )

  it.live("keeps the log from an earlier launch", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* startSignedInBackend(home)

          yield* client.RecordActivity(opened)
        }),
      )

      const { client } = yield* startSignedInBackend(home)
      yield* client.RecordActivity(opened)

      assert.strictEqual(readLog(home).length, 2)
    }),
  )

  it.live(
    "records the current identity after an account change and keeps resume history separate",
    () =>
      Effect.gen(function* () {
        const home = yield* isolatedHome
        const github = yield* startFakeGitHub()

        const seed = {
          owner: "acme",
          repo: "api",
          base: { sha: "b0", files: {} },
          head: { sha: "h1", files: {} },
        }

        const alicePr = github.seedPullRequest({ ...seed, number: 42 })
        const bobPr = github.seedPullRequest({ ...seed, number: 43 })
        let login = "alice"

        const fetch: typeof globalThis.fetch = async (input, init) => {
          const request = new Request(input, init)

          return new URL(request.url).pathname === "/user"
            ? Response.json({ login })
            : globalThis.fetch(request)
        }

        const { client } = yield* startBackend(
          { GH_TOKEN: VIEWER.token, GLASS_GITHUB_API_URL: github.url },
          home,
        ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))

        yield* client.FollowRepository({ input: "acme/api" })
        yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(alicePr) })
        login = "bob"
        assert.strictEqual((yield* client.GetConnection()).login, "bob")
        yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(bobPr) })

        assert.deepStrictEqual(
          readLog(home).map((entry) => entry.login),
          ["alice", "bob"],
        )

        for (const [viewer, expected] of [
          ["alice", 42],
          ["bob", 43],
        ] as const) {
          login = viewer

          const numbers = reviewingNumbers(yield* client.ListPullRequests())

          assert.deepStrictEqual(numbers, [expected])
        }
      }),
  )

  it.live("records adding a to-do and each time it's done, without resuming a PR", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const { client } = yield* startSignedInBackend(home)
      yield* client.FollowRepository({ input: "acme/api" })

      yield* client.AddToDo({ title: "Write the release notes" })
      yield* client.SetToDoDone({ id: 1, done: true })
      yield* client.SetToDoDone({ id: 1, done: true })
      yield* client.EditToDo({ id: 1, title: "Ship the release notes", notes: "" })
      yield* client.SetToDoDone({ id: 1, done: false })
      yield* client.SetToDoDone({ id: 1, done: true })
      yield* client.DeleteToDo({ id: 1 })

      assert.deepStrictEqual(
        readLog(home).map(({ activity }) => activity),
        [
          ToDoAdded.make({ toDo: new ActivityToDo({ id: 1, title: "Write the release notes" }) }),
          ToDoDone.make({ toDo: new ActivityToDo({ id: 1, title: "Write the release notes" }) }),
          ToDoDone.make({ toDo: new ActivityToDo({ id: 1, title: "Ship the release notes" }) }),
        ],
      )
      assert.deepStrictEqual(reviewingNumbers(yield* client.ListPullRequests()), [])
    }),
  )

  it.live("asks GitHub who is signed in once, not for every Activity it records", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      let viewerLookups = 0

      const github = yield* startFakeGitHub({
        beforeRequest: ({ path }) => {
          if (path === "/user") viewerLookups++

          return undefined
        },
      })

      const { client } = yield* startBackend(
        { GH_TOKEN: VIEWER.token, GLASS_GITHUB_API_URL: github.url },
        home,
      )

      yield* client.AddToDo({ title: "Write the release notes" })
      yield* client.AddToDo({ title: "Follow up on #42" })
      yield* client.SetToDoDone({ id: 1, done: true })

      assert.deepStrictEqual(
        readLog(home).map(({ login }) => login),
        [VIEWER.login, VIEWER.login, VIEWER.login],
      )
      assert.strictEqual(viewerLookups, 1)
    }),
  )

  it.live("resumes touched PRs after restarting, scoped to the current Connection", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const github = yield* startFakeGitHub()

      const seed = {
        owner: "acme",
        repo: "api",
        base: { sha: "b0", files: {} },
        head: { sha: "h1", files: {} },
      }

      const touched = github.seedPullRequest({ ...seed, number: 42 })
      github.seedPullRequest({ ...seed, number: 43 })
      const env = { GH_TOKEN: VIEWER.token, GLASS_GITHUB_API_URL: github.url }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* startBackend(env, home)
          yield* client.FollowRepository({ input: "acme/api" })
          yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(touched) })
          yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(touched) })

          const database = new DatabaseSync(join(home, ".project-glass", "glass.db"))

          try {
            database
              .prepare(
                "INSERT INTO activity (kind, payload, occurred_at, login) VALUES (?, ?, ?, ?)",
              )
              .run(
                "PullRequestOpened",
                JSON.stringify(
                  encodeActivity(
                    PullRequestOpened.make({
                      pullRequest: new ActivityPullRequest({
                        ref: new PullRequestRef({ owner: "acme", repo: "api", number: 43 }),
                        title: pullRequest.title,
                        revision: pullRequest.revision,
                      }),
                    }),
                  ),
                ),
                new Date().toISOString(),
                "another-user",
              )
          } finally {
            database.close()
          }
        }),
      )

      const { client } = yield* startBackend(env, home)

      const numbers = reviewingNumbers(yield* client.ListPullRequests())

      assert.deepStrictEqual(numbers, [42])

      touched.edit({ state: "MERGED" })
      assert.deepStrictEqual((yield* client.ListPullRequests()).reviewing, [
        new RepositoryPullRequests({
          repository: new FollowedRepository({ owner: "acme", repo: "api" }),
          pullRequests: [],
        }),
      ])
    }),
  )

  it.live("reports unreadable resume history without preventing other PR lists", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const { client } = yield* startSignedInBackend(home)
      yield* client.FollowRepository({ input: "acme/api" })
      const database = new DatabaseSync(join(home, ".project-glass", "glass.db"))

      try {
        database
          .prepare("INSERT INTO activity (kind, payload, occurred_at, login) VALUES (?, ?, ?, ?)")
          .run(
            "PullRequestOpened",
            JSON.stringify({ pullRequest: { ref: {} } }),
            new Date().toISOString(),
            VIEWER.login,
          )
      } finally {
        database.close()
      }

      const listings = yield* client.ListPullRequests()
      assert.deepStrictEqual(
        listings.reviewingProblem,
        new ActivityLogError({
          message: "Couldn't load the PRs you've touched in Glass. Try again.",
        }),
      )
      assert.strictEqual(listings["needs-review"][0]?._tag, "RepositoryPullRequests")
    }),
  )
})
