import { afterEach, assert, describe, it } from "@effect/vitest"
import {
  FollowedRepository,
  GitHubUnavailable,
  PullRequestList,
  type PullRequestListings,
  PullRequestRef,
  PullRequestSummary,
  type RepositoryListing,
  RepositoryPullRequests,
  RepositoryUnavailable,
} from "@glass/contracts"
import { DateTime, Effect } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { vi } from "vite-plus/test"
import { type FakeGitHub, startFakeGitHub } from "../test/fakeGitHub"
import type { FakePullRequest } from "../test/fakePullRequest"
import { VIEWER } from "../test/fakePullRequest"
import { isolatedHome, startBackend, startSignedInBackend } from "../test/harness"

const base = { sha: "b0", files: {} }

const head = { sha: "h1", files: {} }

const summary = (pr: FakePullRequest, checks: PullRequestSummary["checks"]) =>
  new PullRequestSummary({
    ref: new PullRequestRef({ owner: pr.owner, repo: pr.repo, number: pr.number }),
    url: pr.url,
    title: pr.title,
    author: pr.author ?? "ghost",
    isDraft: pr.isDraft,
    checks,
    updatedAt: DateTime.makeUnsafe(pr.updatedAt),
  })

type Client = Effect.Success<typeof startSignedInBackend>["client"]

const listOf = (listings: PullRequestListings, list: PullRequestList) =>
  listings.reviewingProblem === null
    ? listings[list]
    : assert.fail(`Touched PRs were unreadable: ${listings.reviewingProblem.message}`)

const listed = Effect.fnUntraced(function* (client: Client, list: PullRequestList) {
  const repositories = listOf(yield* client.ListPullRequests(), list)

  return repositories.map((listing) =>
    listing instanceof RepositoryUnavailable
      ? assert.fail(`${listing.repository.repo} was unavailable: ${listing.error.message}`)
      : listing,
  )
})

const numbers = (repositories: ReadonlyArray<RepositoryListing>) =>
  repositories.map((listing) => ({
    repository: `${listing.repository.owner}/${listing.repository.repo}`,
    ...(listing instanceof RepositoryUnavailable && { unavailable: true }),
    numbers: listing.pullRequests.map((pr) => pr.ref.number),
  }))

const membership = Effect.fnUntraced(function* (
  client: Client,
  prs: Readonly<Record<string, FakePullRequest>>,
) {
  const listings = yield* client.ListPullRequests()

  const urls = (list: PullRequestList) =>
    new Set(listOf(listings, list).flatMap((listing) => listing.pullRequests.map((pr) => pr.url)))

  const byList = PullRequestList.literals.map((list) => [list, urls(list)] as const)

  return Object.fromEntries(
    Object.entries(prs).map(([name, pr]) => [
      name,
      byList.flatMap(([list, members]) => (members.has(pr.url) ? [list] : [])),
    ]),
  )
})

const operations = (github: FakeGitHub) =>
  github.graphQLRequests.map((request) => request.operationName)

const drafts = {
  drafts: [{ path: "README.md", line: 1, side: "RIGHT" as const, diffHunk: "", body: "Hmm" }],
}

const approved = (pr: FakePullRequest) => {
  pr.addReview({ author: VIEWER.login, state: "APPROVED" })

  return pr
}

const minute = (minutes: number) => new Date(Date.UTC(2026, 0, 1) + minutes * 60_000).toISOString()

afterEach(() => {
  vi.useRealTimers()
})

describe("Needs review", () => {
  it.live(
    "lists open PRs awaiting the user's or their team's review in followed repositories",
    () =>
      Effect.gen(function* () {
        const { github, client } = yield* startSignedInBackend
        assert.deepStrictEqual(yield* listed(client, "needs-review"), [])
        yield* client.FollowRepository({ input: "octo-org/glass" })
        yield* client.FollowRepository({ input: "effect-ts/effect" })

        const direct = github.seedPullRequest({
          owner: "octo-org",
          repo: "glass",
          title: "Greet the world",
          author: "hubot",
          requestedReviewers: [VIEWER.login],
          checks: "SUCCESS",
          updatedAt: "2026-03-01T10:00:00Z",
          base,
          head,
        })

        const team = github.seedPullRequest({
          owner: "octo-org",
          repo: "glass",
          title: "Wave at the world",
          author: "mona",
          requestedTeams: [VIEWER.teams[0]],
          checks: "FAILURE",
          updatedAt: "2026-03-02T10:00:00Z",
          base,
          head,
        })

        const running = github.seedPullRequest({
          owner: "Effect-TS",
          repo: "effect",
          author: null,
          requestedReviewers: [VIEWER.login],
          checks: "PENDING",
          updatedAt: "2026-02-01T10:00:00Z",
          base,
          head,
        })

        github.seedPullRequest({
          owner: "other-org",
          repo: "unfollowed",
          requestedReviewers: [VIEWER.login],
          base,
          head,
        })

        const unchecked = github.seedPullRequest({
          owner: "octo-org",
          repo: "glass",
          requestedReviewers: [VIEWER.login],
          updatedAt: "2026-01-15T10:00:00Z",
          base,
          head,
        })

        assert.deepStrictEqual(yield* listed(client, "needs-review"), [
          new RepositoryPullRequests({
            repository: new FollowedRepository({ owner: "effect-ts", repo: "effect" }),
            pullRequests: [summary(running, "running")],
          }),
          new RepositoryPullRequests({
            repository: new FollowedRepository({ owner: "octo-org", repo: "glass" }),
            pullRequests: [
              summary(team, "failing"),
              summary(direct, "passing"),
              summary(unchecked, "unavailable"),
            ],
          }),
        ])
      }),
  )

  it.live("keeps only other authors' open, non-draft PRs with an outstanding request", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      yield* client.FollowRepository({ input: "octo-org/glass" })
      yield* client.FollowRepository({ input: "octo-org/quiet" })
      const seed = { owner: "octo-org", repo: "glass", base, head }
      const requested = { ...seed, requestedReviewers: [VIEWER.login] }

      github.seedPullRequest({ ...requested, number: 1, isDraft: true })
      github.seedPullRequest({ ...requested, number: 2, state: "CLOSED" })
      github.seedPullRequest({ ...requested, number: 3, state: "MERGED" })
      github.seedPullRequest({ ...requested, number: 4, author: VIEWER.login })
      github.seedPullRequest({ ...seed, number: 5, requestedReviewers: ["mona"] })
      github.seedPullRequest({ ...seed, number: 6, requestedTeams: ["octo-org/other-team"] })
      github.seedPullRequest({ ...seed, number: 7 })

      const drafting = github.seedPullRequest({ ...requested, number: 8, pendingReview: drafts })

      const reviewed = github.seedPullRequest({ ...requested, number: 9 })
      reviewed.addReview({ author: VIEWER.login, state: "COMMENTED" })
      reviewed.requestReview(VIEWER.login)

      assert.deepStrictEqual(numbers(yield* listed(client, "needs-review")), [
        { repository: "octo-org/glass", numbers: [reviewed.number, drafting.number] },
        { repository: "octo-org/quiet", numbers: [] },
      ])
    }),
  )

  it.live("finds user and team requests beyond the first reviewer page", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      yield* client.FollowRepository({ input: "octo-org/glass" })
      const reviewers = Array.from({ length: 101 }, (_, i) => `reviewer-${i}`)
      const seed = { owner: "octo-org", repo: "glass", base, head }

      const direct = github.seedPullRequest({
        ...seed,
        requestedReviewers: [...reviewers, VIEWER.login.toUpperCase()],
      })

      const team = github.seedPullRequest({
        ...seed,
        requestedReviewers: reviewers,
        requestedTeams: [VIEWER.teams[0]],
      })

      assert.deepStrictEqual(numbers(yield* listed(client, "needs-review")), [
        { repository: "octo-org/glass", numbers: [team.number, direct.number] },
      ])
    }),
  )

  it.live("reports malformed reviewer identities as unreadable GitHub data", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      yield* client.FollowRepository({ input: "octo-org/glass" })
      github.seedPullRequest({
        owner: "octo-org",
        repo: "glass",
        base,
        head,
        requestedReviewers: [""],
      })

      const [glass] = (yield* client.ListPullRequests())["needs-review"]
      assert.instanceOf(glass, RepositoryUnavailable)
      assert.include(glass.error.message, "couldn't read")
    }),
  )

  it.live("fails the lists when the user's teams can't be read", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      yield* client.FollowRepository({ input: "octo-org/glass" })
      github.beforeNext("/user/teams", () => github.failNext(503))

      assert.instanceOf(yield* Effect.flip(client.ListPullRequests()), GitHubUnavailable)
    }),
  )

  it.live("follows GitHub as a request is cleared by a Review and renewed", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      yield* client.FollowRepository({ input: "octo-org/glass" })

      const pr = github.seedPullRequest({
        owner: "octo-org",
        repo: "glass",
        requestedReviewers: [VIEWER.login],
        base,
        head,
      })

      const requested = Effect.map(listed(client, "needs-review"), (repositories) =>
        repositories.flatMap((listing) => listing.pullRequests.map((each) => each.ref.number)),
      )

      assert.deepStrictEqual(yield* requested, [pr.number])
      pr.addReview({ author: VIEWER.login, state: "APPROVED" })
      assert.deepStrictEqual(yield* requested, [])
      pr.requestReview(VIEWER.login)
      assert.deepStrictEqual(yield* requested, [pr.number])
    }),
  )

  it.live("lists every requested PR, newest first, without paging", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      yield* client.FollowRepository({ input: "octo-org/busy" })

      const seeded = Array.from({ length: 205 }, (_, index) =>
        github.seedPullRequest({
          owner: "octo-org",
          repo: "busy",
          requestedReviewers: [VIEWER.login],
          updatedAt: minute(index),
          base,
          head,
        }),
      )

      assert.deepStrictEqual(numbers(yield* listed(client, "needs-review")), [
        { repository: "octo-org/busy", numbers: seeded.toReversed().map((pr) => pr.number) },
      ])
    }),
  )
})

describe("My PRs", () => {
  it.live("lists the user's open PRs, marking those that are drafts", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      yield* client.FollowRepository({ input: "octo-org/glass" })
      const mine = { owner: "octo-org", repo: "glass", author: VIEWER.login, base, head }

      const ready = github.seedPullRequest({ ...mine, updatedAt: "2026-03-01T10:00:00Z" })

      const draft = github.seedPullRequest({
        ...mine,
        isDraft: true,
        updatedAt: "2026-03-02T10:00:00Z",
      })

      github.seedPullRequest({ ...mine, state: "CLOSED" })
      github.seedPullRequest({ ...mine, state: "MERGED" })
      github.seedPullRequest({ ...mine, owner: "other-org", repo: "unfollowed" })
      github.seedPullRequest({ owner: "octo-org", repo: "glass", base, head })

      const [glass] = yield* listed(client, "my-prs")

      assert.deepStrictEqual(
        glass!.pullRequests.map((pr) => ({ number: pr.ref.number, isDraft: pr.isDraft })),
        [
          { number: draft.number, isDraft: true },
          { number: ready.number, isDraft: false },
        ],
      )
    }),
  )
})

describe("PR list membership", () => {
  it.live("includes touched PRs in Reviewing alongside outstanding review requests", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      yield* client.FollowRepository({ input: "octo-org/glass" })
      const seed = { owner: "octo-org", repo: "glass", base, head }
      const requested = { ...seed, requestedReviewers: [VIEWER.login] }
      const mine = { ...seed, author: VIEWER.login }

      const prs = {
        requested: github.seedPullRequest(requested),
        teamRequestedWithDrafts: github.seedPullRequest({
          ...seed,
          requestedTeams: [VIEWER.teams[0]],
          pendingReview: drafts,
        }),
        reRequestedAfterReview: approved(github.seedPullRequest(requested)),
        commentedWhileRequested: github.seedPullRequest(requested),
        requestedOfSomeoneElse: github.seedPullRequest({ ...seed, requestedReviewers: ["mona"] }),
        requestedOfAnotherTeam: github.seedPullRequest({
          ...seed,
          requestedTeams: ["octo-org/other-team"],
        }),
        privateDraftsOnly: github.seedPullRequest({ ...seed, pendingReview: drafts }),
        emptyPendingReview: github.seedPullRequest({ ...seed, pendingReview: { drafts: [] } }),
        reviewed: approved(github.seedPullRequest(seed)),
        commented: github.seedPullRequest(seed),
        inlineCommented: github.seedPullRequest(seed),
        reviewedLongAgo: approved(
          github.seedPullRequest({ ...seed, updatedAt: "2019-05-01T10:00:00Z" }),
        ),
        openedOnly: github.seedPullRequest(seed),
        openedWhileRequested: github.seedPullRequest(requested),
        othersFeedbackOnly: github.seedPullRequest(seed),
        othersDraftReviewed: approved(
          github.seedPullRequest({ ...requested, isDraft: true, pendingReview: drafts }),
        ),
        closedReviewed: approved(github.seedPullRequest({ ...requested, state: "CLOSED" })),
        mergedReviewed: approved(github.seedPullRequest({ ...seed, state: "MERGED" })),
        mine: github.seedPullRequest(mine),
        myDraft: github.seedPullRequest({ ...mine, isDraft: true }),
        myClosed: github.seedPullRequest({ ...mine, state: "CLOSED" }),
      }

      prs.reRequestedAfterReview.requestReview(VIEWER.login)
      prs.commentedWhileRequested.addComment({ author: VIEWER.login, bodyHtml: "<p>Hi</p>" })
      prs.commented.addComment({ author: VIEWER.login, bodyHtml: "<p>Nice</p>" })
      prs.inlineCommented.addReviewThread({
        path: "README.md",
        line: 1,
        comments: [{ author: VIEWER.login, bodyHtml: "<p>Nice</p>" }],
      })
      prs.othersFeedbackOnly.addComment({ author: "mona", bodyHtml: "<p>Hmm</p>" })
      prs.othersFeedbackOnly.addReview({ author: "mona", state: "APPROVED" })
      prs.mine.addComment({ author: VIEWER.login, bodyHtml: "<p>Ready</p>" })

      for (const pr of [prs.openedOnly, prs.openedWhileRequested]) {
        yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })
      }

      assert.deepStrictEqual(yield* membership(client, prs), {
        requested: ["needs-review"],
        teamRequestedWithDrafts: ["needs-review", "reviewing"],
        reRequestedAfterReview: ["needs-review", "reviewing"],
        commentedWhileRequested: ["needs-review"],
        requestedOfSomeoneElse: [],
        requestedOfAnotherTeam: [],
        privateDraftsOnly: ["reviewing"],
        emptyPendingReview: [],
        reviewed: ["reviewing"],
        commented: [],
        inlineCommented: [],
        reviewedLongAgo: ["reviewing"],
        openedOnly: ["reviewing"],
        openedWhileRequested: ["needs-review", "reviewing"],
        othersFeedbackOnly: [],
        othersDraftReviewed: [],
        closedReviewed: [],
        mergedReviewed: [],
        mine: ["my-prs"],
        myDraft: ["my-prs"],
        myClosed: [],
      })
    }),
  )

  it.live("keeps Reviewing resumable as GitHub clears, renews, and closes review requests", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      yield* client.FollowRepository({ input: "octo-org/glass" })
      const seed = { owner: "octo-org", repo: "glass", base, head }

      const prs = {
        reviewed: github.seedPullRequest({ ...seed, requestedReviewers: [VIEWER.login] }),
        teamCleared: github.seedPullRequest({ ...seed, requestedTeams: [VIEWER.teams[0]] }),
        teamClearedAfterComment: github.seedPullRequest({
          ...seed,
          requestedTeams: [VIEWER.teams[0]],
        }),
        backToDraft: github.seedPullRequest({ ...seed, pendingReview: drafts }),
        merged: github.seedPullRequest({ ...seed, pendingReview: drafts }),
      }

      prs.reviewed.addReview({ author: VIEWER.login, state: "COMMENTED" })
      prs.teamCleared.requestedTeams.clear()
      prs.teamClearedAfterComment.addComment({ author: VIEWER.login, bodyHtml: "<p>Hi</p>" })
      prs.teamClearedAfterComment.requestedTeams.clear()
      prs.backToDraft.edit({ isDraft: true })
      prs.merged.edit({ state: "MERGED" })

      assert.deepStrictEqual(yield* membership(client, prs), {
        reviewed: ["reviewing"],
        teamCleared: [],
        teamClearedAfterComment: [],
        backToDraft: [],
        merged: [],
      })

      prs.reviewed.requestReview(VIEWER.login)
      prs.backToDraft.edit({ isDraft: false })

      assert.deepStrictEqual(yield* membership(client, prs), {
        reviewed: ["needs-review", "reviewing"],
        teamCleared: [],
        teamClearedAfterComment: [],
        backToDraft: ["reviewing"],
        merged: [],
      })
    }),
  )

  it.live("lists every qualifying Reviewing PR beyond GitHub's first page of open PRs", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      yield* client.FollowRepository({ input: "octo-org/busy" })
      const seed = { owner: "octo-org", repo: "busy", base, head }

      Array.from({ length: 150 }, (_, index) =>
        github.seedPullRequest({ ...seed, updatedAt: minute(2 * index + 1) }),
      )

      const drafting = github.seedPullRequest({
        ...seed,
        updatedAt: minute(0),
        pendingReview: drafts,
      })

      const reviewed = github.seedPullRequest({ ...seed, updatedAt: minute(400) })
      reviewed.addReview({ author: VIEWER.login, state: "APPROVED" })

      assert.deepStrictEqual(numbers(yield* listed(client, "reviewing")), [
        { repository: "octo-org/busy", numbers: [reviewed.number, drafting.number] },
      ])
    }),
  )
})

describe("Reviewing participation", () => {
  it.live("includes Drafts and every submitted Review decision", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      yield* client.FollowRepository({ input: "octo-org/glass" })
      const seed = { owner: "octo-org", repo: "glass", base, head }

      const reviewed = (["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"] as const).map(
        (state) => {
          const pr = github.seedPullRequest(seed)
          pr.addReview({ author: VIEWER.login.toUpperCase(), state })

          return pr
        },
      )

      const drafting = github.seedPullRequest({ ...seed, pendingReview: drafts })
      const [group] = yield* listed(client, "reviewing")

      assert.deepStrictEqual(
        group!.pullRequests.map((pr) => pr.ref.number),
        [drafting, ...reviewed.toReversed()].map((pr) => pr.number),
      )
    }),
  )
})

describe("Keeping up with GitHub", () => {
  it.live("catches up on what changed since the last sync without reading every PR", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      yield* client.FollowRepository({ input: "octo-org/glass" })
      const seed = { owner: "octo-org", repo: "glass", requestedReviewers: [VIEWER.login] }

      const [closing, ...others] = Array.from({ length: 150 }, (_, index) =>
        github.seedPullRequest({ ...seed, updatedAt: minute(index), base, head }),
      )

      yield* listed(client, "needs-review")
      const firstSync = github.graphQLRequests.length
      closing!.edit({ state: "CLOSED" })
      const added = github.seedPullRequest({ ...seed, base, head })

      assert.deepStrictEqual(numbers(yield* listed(client, "needs-review")), [
        {
          repository: "octo-org/glass",
          numbers: [added, ...others.toReversed()].map((pr) => pr.number),
        },
      ])
      assert.deepStrictEqual(operations(github).slice(firstSync), [
        "SearchPullRequests",
        "PullRequestChecks",
        "PullRequestChecks",
      ])
    }),
  )

  it.live("reads every PR again after ten minutes, catching changes that skip updatedAt", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() })
      const { github, client } = yield* startSignedInBackend
      yield* client.FollowRepository({ input: "octo-org/glass" })

      const pr = github.seedPullRequest({
        owner: "octo-org",
        repo: "glass",
        requestedTeams: [VIEWER.teams[0]],
        updatedAt: minute(0),
        base,
        head,
      })

      const requested = Effect.map(listed(client, "needs-review"), (repositories) =>
        repositories.flatMap((listing) => listing.pullRequests.map((each) => each.ref.number)),
      )

      assert.deepStrictEqual(yield* requested, [pr.number])
      pr.requestedTeams.clear()
      assert.deepStrictEqual(yield* requested, [pr.number])

      vi.advanceTimersByTime(10 * 60_000)
      assert.deepStrictEqual(yield* requested, [])
      assert.include(operations(github), "RepositoryPullRequests")
    }),
  )

  it.live("reads checks for listed PRs only, and shows them as they change", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      yield* client.FollowRepository({ input: "octo-org/glass" })
      const seed = { owner: "octo-org", repo: "glass", base, head }

      const pr = github.seedPullRequest({
        ...seed,
        requestedReviewers: [VIEWER.login],
        checks: "PENDING",
      })

      github.seedPullRequest({ ...seed, checks: "SUCCESS" })

      const checks = Effect.map(
        listed(client, "needs-review"),
        ([glass]) => glass?.pullRequests.map((each) => each.checks) ?? [],
      )

      assert.deepStrictEqual(yield* checks, ["running"])
      pr.checks = "SUCCESS"
      assert.deepStrictEqual(yield* checks, ["passing"])
      assert.deepStrictEqual(
        github.graphQLRequests.flatMap((request) =>
          request.operationName === "PullRequestChecks" ? [request.variables.ids] : [],
        ),
        [[pr.id], [pr.id]],
      )
    }),
  )

  it.live("keeps a failing repository's last rows listed beside healthy ones", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      yield* client.FollowRepository({ input: "octo-org/broken" })
      yield* client.FollowRepository({ input: "octo-org/glass" })
      yield* client.FollowRepository({ input: "octo-org/never" })
      const seed = { requestedReviewers: [VIEWER.login], base, head }
      const broken = github.seedPullRequest({ owner: "octo-org", repo: "broken", ...seed })
      github.unavailableRepositories.add("octo-org/never")

      const healthy = github.seedPullRequest({ owner: "octo-org", repo: "glass", ...seed })
      assert.deepStrictEqual(numbers((yield* client.ListPullRequests())["needs-review"]), [
        { repository: "octo-org/broken", numbers: [broken.number] },
        { repository: "octo-org/glass", numbers: [healthy.number] },
        { repository: "octo-org/never", unavailable: true, numbers: [] },
      ])

      github.unavailableRepositories.add("octo-org/broken")
      const [failed] = (yield* client.ListPullRequests())["needs-review"]
      assert.instanceOf(failed, RepositoryUnavailable)
      assert.instanceOf(failed.error, GitHubUnavailable)
      assert.deepStrictEqual(
        failed.pullRequests.map((each) => each.ref.number),
        [broken.number],
      )

      github.unavailableRepositories.clear()
      assert.deepStrictEqual(numbers(yield* listed(client, "needs-review")), [
        { repository: "octo-org/broken", numbers: [broken.number] },
        { repository: "octo-org/glass", numbers: [healthy.number] },
        { repository: "octo-org/never", numbers: [] },
      ])
    }),
  )
})

describe("Saved lists", () => {
  it.live("keeps the lists across restarts, without asking GitHub", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const github = yield* startFakeGitHub()
      const env = { GH_TOKEN: VIEWER.token, GLASS_GITHUB_API_URL: github.url }
      const { client } = yield* startBackend(env, home)
      yield* client.FollowRepository({ input: "octo-org/broken" })
      yield* client.FollowRepository({ input: "octo-org/glass" })
      const seed = { requestedReviewers: [VIEWER.login], base, head }
      const broken = github.seedPullRequest({ owner: "octo-org", repo: "broken", ...seed })
      const healthy = github.seedPullRequest({ owner: "octo-org", repo: "glass", ...seed })

      assert.isNull(yield* client.ListSavedPullRequests())
      yield* client.ListPullRequests()

      const restarted = yield* startBackend(env, home)
      const asked = github.graphQLRequests.length
      const saved = yield* restarted.client.ListSavedPullRequests()
      assert.strictEqual(github.graphQLRequests.length, asked)
      assert.deepStrictEqual(numbers(saved!["needs-review"]), [
        { repository: "octo-org/broken", numbers: [broken.number] },
        { repository: "octo-org/glass", numbers: [healthy.number] },
      ])

      yield* restarted.client.UnfollowRepository({
        repository: new FollowedRepository({ owner: "octo-org", repo: "broken" }),
      })
      assert.deepStrictEqual(
        numbers((yield* restarted.client.ListSavedPullRequests())!["needs-review"]),
        [{ repository: "octo-org/glass", numbers: [healthy.number] }],
      )
    }),
  )

  it.live("treats an unreadable saved file as nothing saved and replaces it", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      yield* Effect.promise(async () => {
        await mkdir(join(home, ".project-glass"), { recursive: true })
        await writeFile(join(home, ".project-glass", "pull-requests.json"), "{ not json")
      })
      const github = yield* startFakeGitHub()
      const env = { GH_TOKEN: VIEWER.token, GLASS_GITHUB_API_URL: github.url }
      const { client } = yield* startBackend(env, home)
      yield* client.FollowRepository({ input: "octo-org/glass" })
      const seed = { owner: "octo-org", repo: "glass", requestedReviewers: [VIEWER.login] }
      const pr = github.seedPullRequest({ ...seed, base, head })

      assert.isNull(yield* client.ListSavedPullRequests())
      yield* client.ListPullRequests()
      assert.deepStrictEqual(numbers((yield* client.ListSavedPullRequests())!["needs-review"]), [
        { repository: "octo-org/glass", numbers: [pr.number] },
      ])
    }),
  )
})
