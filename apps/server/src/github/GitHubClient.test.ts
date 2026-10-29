import { assert, describe, it } from "@effect/vitest"
import {
  BinaryFile,
  Check,
  Discussions,
  FileNotFound,
  FileTooLarge,
  GitHubUnavailable,
  NoCredentials,
  PullRequest,
  PullRequestAccessDenied,
  PullRequestNotFound,
  PullRequestRef,
  PullRequestWorkspace,
  Viewer,
  RepositoryFiles,
  Reviewer,
  Revision,
  TextFile,
  TokenRejected,
} from "@glass/contracts"
import { DateTime, Effect } from "effect"
import { vi } from "vite-plus/test"
import { startFakeGitHub } from "../../test/fakeGitHub"
import { avatarUrl } from "../../test/fakeNodes"
import { VIEWER } from "../../test/fakePullRequest"
import { startBackend, startSignedInBackend } from "../../test/harness"

describe("GetConnection", () => {
  it.live("reports the authenticated login using GH_TOKEN ahead of GITHUB_TOKEN", () =>
    Effect.gen(function* () {
      const github = yield* startFakeGitHub()

      const { client } = yield* startBackend({
        GH_TOKEN: VIEWER.token,
        GITHUB_TOKEN: "other-token",
        GLASS_GITHUB_API_URL: github.url,
      })

      const connection = yield* client.GetConnection()

      assert.strictEqual(connection.login, VIEWER.login)
      assert.strictEqual(connection.tokenSource, "GH_TOKEN")
    }),
  )

  it.live("reports no credentials when no token is supplied and gh is unavailable", () =>
    Effect.gen(function* () {
      vi.stubEnv("PATH", "")
      const github = yield* startFakeGitHub()
      const { client } = yield* startBackend({ GLASS_GITHUB_API_URL: github.url })

      assert.instanceOf(yield* Effect.flip(client.GetConnection()), NoCredentials)
    }),
  )

  it.live("reports a token GitHub rejects", () =>
    Effect.gen(function* () {
      const github = yield* startFakeGitHub()

      const { client } = yield* startBackend({
        GITHUB_TOKEN: "revoked-token",
        GLASS_GITHUB_API_URL: github.url,
      })

      const error = yield* Effect.flip(client.GetConnection())

      assert.instanceOf(error, TokenRejected)
      assert.strictEqual(error.tokenSource, "GITHUB_TOKEN")
    }),
  )

  it.live("explains a dropped connection in plain words", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      github.failNext("disconnect")

      const error = yield* Effect.flip(client.GetConnection())

      assert.deepStrictEqual(
        error,
        new GitHubUnavailable({
          message: "Check your internet connection, then try again.",
        }),
      )
    }),
  )

  it.live("explains a GitHub server error in plain words", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      github.failNext(503)

      const error = yield* Effect.flip(client.GetConnection())

      assert.deepStrictEqual(
        error,
        new GitHubUnavailable({
          message: "GitHub had a problem answering (HTTP 503). Try again in a moment.",
        }),
      )
    }),
  )
})

const base = { sha: "b0", files: { "README.md": "Hello\n" } }

const head = { sha: "h1", files: { "README.md": "Hello, world\n" } }

describe("OpenPullRequest", () => {
  it.live("opens explicit unfollowed references without changing followed repositories", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      yield* client.FollowRepository({ input: "octo-org/followed" })
      const configured = yield* client.ListFollowedRepositories()

      const pr = github.seedPullRequest({
        owner: "another",
        repo: "unfollowed",
        number: 42,
        base,
        head,
      })

      const workspace = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })
      assert.strictEqual(workspace.pullRequest.url, pr.url)
      assert.deepStrictEqual(yield* client.ListFollowedRepositories(), configured)
    }),
  )

  it.live("opens the PR's metadata pinned to its current Revision", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      const pr = github.seedPullRequest({
        owner: "octo-org",
        repo: "hello-world",
        number: 42,
        title: "Greet the world",
        author: "hubot",
        baseBranch: "main",
        headBranch: "greeting",
        bodyHtml: "<p>Says <strong>hello</strong>.</p>",
        base,
        head,
      })

      const workspace = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.deepStrictEqual(
        workspace,
        new PullRequestWorkspace({
          viewer: new Viewer({ login: VIEWER.login, avatarUrl: avatarUrl(VIEWER.login) }),
          pullRequest: new PullRequest({
            id: pr.id,
            ref: new PullRequestRef({ owner: "octo-org", repo: "hello-world", number: 42 }),
            url: "https://github.com/octo-org/hello-world/pull/42",
            title: "Greet the world",
            author: "hubot",
            baseBranch: "main",
            headBranch: "greeting",
            state: "open",
            descriptionHtml: "<p>Says <strong>hello</strong>.</p>",
            viewerIsAuthor: false,
            approval: null,
            reviewers: [],
            checks: [],
            mergeable: "mergeable",
          }),
          revision: new Revision({ base: "b0", head: "h1" }),
          updatedAt: DateTime.makeUnsafe(pr.updatedAt),
          files: [],
          viewedPaths: [],
          discussions: new Discussions({ onLines: [], outdated: [], timeline: [] }),
          drafts: [],
        }),
      )
    }),
  )

  it.live("names the PR as GitHub spells it, whatever case was supplied", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      github.seedPullRequest({ owner: "octo-org", repo: "Hello-World", number: 3, base, head })

      const { pullRequest } = yield* client.OpenPullRequest({
        pullRequest: new PullRequestRef({ owner: "OCTO-ORG", repo: "hello-world", number: 3 }),
      })

      assert.deepStrictEqual(
        pullRequest.ref,
        new PullRequestRef({ owner: "octo-org", repo: "Hello-World", number: 3 }),
      )
    }),
  )

  it.live("reopens at the Revision the PR has moved to", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head })
      const opened = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      pr.push({ head: { sha: "h2", files: { "README.md": "Hi, world\n" } } })
      const reopened = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.deepStrictEqual(opened.revision, new Revision({ base: "b0", head: "h1" }))
      assert.deepStrictEqual(reopened.revision, new Revision({ base: "b0", head: "h2" }))
    }),
  )

  it.live("tells whether the PR changed since it was opened", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head })

      const { pullRequest, revision, updatedAt } = yield* client.OpenPullRequest({
        pullRequest: new PullRequestRef(pr),
      })

      const changed = client.HasPullRequestChanged({
        pullRequestId: pullRequest.id,
        revision,
        updatedAt,
      })

      assert.isFalse(yield* changed)

      pr.edit({ isDraft: true })
      assert.isTrue(yield* changed)
    }),
  )

  it.live("tells the PR changed when it moved to a new Revision", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head })

      const { pullRequest, revision, updatedAt } = yield* client.OpenPullRequest({
        pullRequest: new PullRequestRef(pr),
      })

      pr.push({ head: { sha: "h2", files: { "README.md": "Hi, world\n" } } })

      assert.isTrue(
        yield* client.HasPullRequestChanged({ pullRequestId: pullRequest.id, revision, updatedAt }),
      )
    }),
  )

  it.live("shows where each reviewer stands, awaiting anyone asked again", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      const pr = github.seedPullRequest({
        reviewDecision: "CHANGES_REQUESTED",
        requestedTeams: ["octo-org/reviewers"],
        base,
        head,
      })

      pr.addReview({ author: "mona", state: "APPROVED" })
      pr.addReview({ author: "mona", state: "COMMENTED" })
      pr.addReview({ author: "hubot", state: "APPROVED" })
      pr.addReview({ author: "hubot", state: "CHANGES_REQUESTED" })
      pr.addReview({ author: "dependabot", state: "APPROVED" })
      pr.addReview({ author: "dependabot", state: "DISMISSED" })
      pr.addReview({ author: "octocat", state: "APPROVED" })
      pr.requestedReviewers.add("octocat")

      const { pullRequest } = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.strictEqual(pullRequest.approval, "changes-requested")
      assert.deepStrictEqual(pullRequest.reviewers, [
        new Reviewer({ name: "mona", state: "approved" }),
        new Reviewer({ name: "hubot", state: "changes-requested" }),
        new Reviewer({ name: "octocat", state: "requested" }),
        new Reviewer({ name: "octo-org/reviewers", state: "requested" }),
      ])
    }),
  )

  it.live("lists the head commit's checks the way GitHub's rollup counts them", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      const pr = github.seedPullRequest({
        checkContexts: [
          { kind: "CheckRun", name: "test", workflow: "ci", url: "https://ci.test/1" },
          { kind: "CheckRun", name: "lint", workflow: "ci", status: "IN_PROGRESS" },
          { kind: "CheckRun", name: "build", conclusion: "FAILURE" },
          { kind: "CheckRun", name: "deploy", conclusion: "CANCELLED" },
          { kind: "CheckRun", name: "label", conclusion: "NEUTRAL" },
          { kind: "CheckRun", name: "docs", conclusion: "SKIPPED" },
          {
            kind: "StatusContext",
            context: "ci/circleci",
            state: "PENDING",
            url: "https://circle.test",
          },
        ],
        base,
        head,
      })

      const { pullRequest } = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.deepStrictEqual(pullRequest.checks, [
        new Check({ name: "ci / test", state: "passed", url: "https://ci.test/1" }),
        new Check({ name: "ci / lint", state: "running", url: null }),
        new Check({ name: "build", state: "failed", url: null }),
        new Check({ name: "deploy", state: "failed", url: null }),
        new Check({ name: "label", state: "passed", url: null }),
        new Check({ name: "docs", state: "skipped", url: null }),
        new Check({ name: "ci/circleci", state: "running", url: "https://circle.test" }),
      ])
    }),
  )

  it.live("tells whether the PR conflicts with its base branch", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      for (const [seed, expected] of [
        ["MERGEABLE", "mergeable"],
        ["CONFLICTING", "conflicting"],
        ["UNKNOWN", "checking"],
      ] as const) {
        const pr = github.seedPullRequest({ mergeable: seed, base, head })

        const { pullRequest } = yield* client.OpenPullRequest({
          pullRequest: new PullRequestRef(pr),
        })

        assert.strictEqual(pullRequest.mergeable, expected)
      }
    }),
  )

  it.live("labels each PR state and shows a deleted author as ghost", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      const seeds = [
        { state: "OPEN", isDraft: false, expected: "open" },
        { state: "OPEN", isDraft: true, expected: "draft" },
        { state: "CLOSED", isDraft: false, expected: "closed" },
        { state: "MERGED", isDraft: false, expected: "merged" },
      ] as const

      for (const { expected, ...seed } of seeds) {
        const pr = github.seedPullRequest({ ...seed, author: null, base, head })

        const { pullRequest } = yield* client.OpenPullRequest({
          pullRequest: new PullRequestRef(pr),
        })

        assert.strictEqual(pullRequest.state, expected)
        assert.strictEqual(pullRequest.author, "ghost")
      }
    }),
  )

  it.live("reports a missing PR or repository as not found", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      github.seedPullRequest({ owner: "octo-org", repo: "hello-world", number: 1, base, head })

      const refs = [
        new PullRequestRef({ owner: "octo-org", repo: "hello-world", number: 2 }),
        new PullRequestRef({ owner: "someone", repo: "private-repo", number: 3 }),
      ]

      for (const ref of refs) {
        const error = yield* Effect.flip(client.OpenPullRequest({ pullRequest: ref }))

        assert.deepStrictEqual(error, new PullRequestNotFound({ ref }))
      }
    }),
  )

  it.live("reports access GitHub refuses, with its reason", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ owner: "sso-org", repo: "app", number: 5, base, head })

      const reason =
        "Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization."

      github.failNextGraphQL({ type: "FORBIDDEN", message: reason })

      const error = yield* Effect.flip(
        client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) }),
      )

      assert.deepStrictEqual(
        error,
        new PullRequestAccessDenied({
          ref: new PullRequestRef({ owner: "sso-org", repo: "app", number: 5 }),
          message: reason,
        }),
      )
    }),
  )

  it.live("explains an unexpected GraphQL error in plain words", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const pr = github.seedPullRequest({ base, head })
      github.failNextGraphQL({ type: "INTERNAL", message: "Something went wrong" })

      const error = yield* Effect.flip(
        client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) }),
      )

      assert.deepStrictEqual(
        error,
        new GitHubUnavailable({
          message: "GitHub had a problem answering. Try again in a moment.",
        }),
      )
    }),
  )
})

const contentsBase = { sha: "b0", files: { "README.md": "Hello\n", "src/greet.ts": "hi\n" } }

const contentsHead = {
  sha: "h1",
  files: { "README.md": "Hello, world\n", "src/greet.ts": "hi\n", "src/new.ts": "new\n" },
}

const contentsChangedFiles = [
  { path: "README.md", status: "modified", additions: 1, deletions: 1, patch: "@@" },
  { path: "src/new.ts", status: "added", additions: 1, patch: "@@" },
] as const

const openThenPush = Effect.gen(function* () {
  const { github, client } = yield* startSignedInBackend

  const pr = github.seedPullRequest({
    base: contentsBase,
    head: contentsHead,
    changedFiles: contentsChangedFiles,
  })

  const { pullRequest, revision } = yield* client.OpenPullRequest({
    pullRequest: new PullRequestRef(pr),
  })

  pr.push({
    head: {
      sha: "h2",
      files: { ...contentsHead.files, "README.md": "Hi, world\n", "src/later.ts": "later\n" },
    },
  })

  return { client, ref: pullRequest.ref, revision }
})

describe("file contents", () => {
  it.live("reads each side of the pinned Revision, not the latest", () =>
    Effect.gen(function* () {
      const { client, ref, revision } = yield* openThenPush

      const read = (side: "base" | "head") =>
        client.GetFileContents({ pullRequest: ref, revision, side, path: "README.md" })

      assert.deepStrictEqual(yield* read("base"), TextFile.make({ text: "Hello\n" }))
      assert.deepStrictEqual(yield* read("head"), TextFile.make({ text: "Hello, world\n" }))
    }),
  )

  it.live("tells binary and too-large files apart from text", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      const pr = github.seedPullRequest({
        base: { sha: "b0", files: {} },
        head: {
          sha: "h1",
          files: { "logo.png": "\u0089PNG\u0000\u0001", "big.txt": "x".repeat(600_000) },
        },
      })

      const { pullRequest, revision } = yield* client.OpenPullRequest({
        pullRequest: new PullRequestRef(pr),
      })

      const read = (path: string) =>
        client.GetFileContents({ pullRequest: pullRequest.ref, revision, side: "head", path })

      assert.deepStrictEqual(yield* read("logo.png"), BinaryFile.make({}))
      assert.deepStrictEqual(yield* read("big.txt"), FileTooLarge.make({}))
    }),
  )

  it.live("fails for a path the side doesn't have", () =>
    Effect.gen(function* () {
      const { client, ref, revision } = yield* openThenPush

      const error = yield* Effect.flip(
        client.GetFileContents({ pullRequest: ref, revision, side: "base", path: "src/new.ts" }),
      )

      assert.deepStrictEqual(error, new FileNotFound({ path: "src/new.ts", side: "base" }))
    }),
  )

  it.live("fails as not found once GitHub can't see the repository", () =>
    Effect.gen(function* () {
      const { client, ref, revision } = yield* openThenPush

      const gone = new PullRequestRef({
        owner: ref.owner,
        repo: "deleted-repo",
        number: ref.number,
      })

      const error = yield* Effect.flip(
        client.GetFileContents({ pullRequest: gone, revision, side: "head", path: "README.md" }),
      )

      assert.deepStrictEqual(error, new PullRequestNotFound({ ref: gone }))
    }),
  )
})

describe("repository files", () => {
  it.live("lists every file at the pinned head, not the latest", () =>
    Effect.gen(function* () {
      const { client, ref, revision } = yield* openThenPush

      const files = yield* client.ListRepositoryFiles({ pullRequest: ref, revision })

      assert.deepStrictEqual(
        files,
        new RepositoryFiles({
          paths: ["README.md", "src/greet.ts", "src/new.ts"],
          truncated: false,
        }),
      )
    }),
  )
})
