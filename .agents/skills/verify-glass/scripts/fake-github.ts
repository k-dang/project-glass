import { Effect, Schema } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import {
  type FakeGitHub,
  type FakeGitHubRequest,
  startFakeGitHub,
} from "../../../../apps/server/test/fakeGitHub.ts"
import { VIEWER } from "../../../../apps/server/test/fakePullRequest.ts"
import type { FakeChangedFile } from "../../../../apps/server/test/fakePullRequest.ts"

export const FAKE_MODES = ["ok", "401", "500", "down", "busy-500"] as const
const FakeMode = Schema.Literals(FAKE_MODES)
export const isFakeMode = Schema.is(FakeMode)
const decodeMode = Schema.decodeUnknownSync(FakeMode)

const samples = [
  {
    number: 101,
    list: "needs-review",
    title: "Wide change across 150 files",
    author: "mona",
    isDraft: false,
    checks: "SUCCESS",
    wide: true,
  },
  {
    number: 100,
    list: "needs-review",
    title: "Retry Draft saves after a dropped connection",
    author: "mona",
    isDraft: false,
    checks: "SUCCESS",
  },
  {
    number: 99,
    list: "needs-review",
    title: "Group changed files by folder in the tree and keep the selection when filtering",
    author: "hubot",
    isDraft: false,
    checks: "FAILURE",
  },
  {
    number: 98,
    list: "needs-review",
    title: "Show outdated discussions under their file",
    author: "monalisa",
    isDraft: false,
    checks: "PENDING",
  },
  {
    number: 97,
    list: "needs-review",
    title: "Bump effect",
    author: "dependabot",
    isDraft: false,
    checks: null,
  },
  {
    number: 96,
    list: "my-prs",
    title: "Sketch the inbox",
    author: VIEWER.login,
    isDraft: true,
    checks: "PENDING",
  },
  {
    number: 95,
    list: "my-prs",
    title: "Cache followed repositories",
    author: VIEWER.login,
    isDraft: false,
    checks: "SUCCESS",
  },
  {
    number: 94,
    list: "reviewing",
    title: "Collapse resolved discussions",
    author: "mona",
    isDraft: false,
    checks: "SUCCESS",
  },
] as const

const repositoryOf = ({ path, graphql }: FakeGitHubRequest) => {
  switch (graphql?.operationName) {
    case "RepositoryPullRequests":
    case "PullRequest":
    case "TourInput":
      return [graphql.variables.owner, graphql.variables.name] as const
    case "SearchPullRequests": {
      const match = /repo:([^/\s]+)\/(\S+)/.exec(graphql.variables.query)
      return match === null ? undefined : ([match[1]!, match[2]!] as const)
    }
    default: {
      const match = /^\/repos\/([^/]+)\/([^/]+)\//.exec(path)
      return match === null ? undefined : ([match[1]!, match[2]!] as const)
    }
  }
}

/** One PR wide enough to fill the diff cache and every Shiki worker, so memory runs compare. */
const WIDE_FILE_COUNT = 150
const WIDE_FILE_LINES = 40

const wideChangedFiles = () => {
  const changed: Array<FakeChangedFile> = []
  const head: Record<string, string> = {}
  for (let index = 0; index < WIDE_FILE_COUNT; index++) {
    const path = `src/feature-${String(index + 1).padStart(3, "0")}/index.ts`
    const lines = Array.from(
      { length: WIDE_FILE_LINES },
      (_, line) => `export const value${line} = ${line + index}`,
    )
    head[path] = `${lines.join("\n")}\n`
    let additions = 0
    let deletions = 0
    const body = lines.map((line, position) => {
      if (position % 7 !== 3) return ` ${line}`
      additions++
      deletions++
      return `-${line}\n+${line} // changed`
    })
    changed.push({
      path,
      status: "modified",
      additions,
      deletions,
      patch: `@@ -1,${lines.length} +1,${lines.length} @@\n${body.join("\n")}`,
    })
  }
  return { changed, head }
}

const seedRepository = (github: FakeGitHub, owner: string, repo: string) => {
  const needsReview = samples.filter((pr) => pr.list === "needs-review")
  const pullRequests =
    repo === "quiet"
      ? []
      : repo === "busy"
        ? [
            ...Array.from({ length: 134 }, (_, index) => ({
              ...needsReview[index % needsReview.length]!,
              number: 134 - index,
            })),
            ...samples
              .filter((pr) => pr.list !== "needs-review")
              .map((pr, index) => ({ ...pr, number: 135 + index })),
          ]
        : samples
  const now = Date.now()
  const patch = "@@ -1 +1 @@\n-hello\n+hello name"

  for (const [index, sample] of pullRequests.entries()) {
    const wide = "wide" in sample && sample.wide === true ? wideChangedFiles() : undefined
    const pr = github.seedPullRequest({
      owner,
      repo,
      number: sample.number,
      title: repo === "busy" ? `${sample.title} (${sample.number})` : sample.title,
      author: sample.author,
      isDraft: sample.isDraft,
      checks: sample.checks ?? undefined,
      updatedAt: new Date(now - (index + 1) * 3_600_000).toISOString(),
      requestedReviewers: sample.list === "needs-review" ? [VIEWER.login] : [],
      base: { sha: "b0", files: wide?.head ?? { "greet.ts": "hello\n" } },
      head: { sha: "h1", files: wide?.head ?? { "greet.ts": "hello name\n" } },
      changedFiles: wide?.changed ?? [
        { path: "greet.ts", status: "modified", additions: 1, deletions: 1, patch },
      ],
    })
    if (sample.list === "reviewing") {
      pr.addDraft({ path: "greet.ts", line: 1, side: "RIGHT", body: "Why names?", diffHunk: patch })
    }

    if (sample.list === "my-prs" && !sample.isDraft) {
      pr.addReviewThread({
        path: "greet.ts",
        line: 1,
        side: "RIGHT",
        diffHunk: patch,
        comments: [{ author: "mona", bodyHtml: "<p>Cache the list, or the lookup?</p>" }],
      })
    }
  }
}

const startVerificationGitHub = Effect.fnUntraced(function* (modeFile: string) {
  const seeded = new Set<string>()

  return yield* startFakeGitHub({
    beforeRequest: (request, github) => {
      const mode = decodeMode(readFileSync(modeFile, "utf8").trim())
      console.log(`${request.method} ${request.path} -> ${mode}`)

      const repository = repositoryOf(request)
      if (repository !== undefined) {
        const [owner, repo] = repository
        const key = `${owner}/${repo}`.toLowerCase()
        if (!seeded.has(key)) {
          seeded.add(key)
          seedRepository(github, owner, repo)
        }
      }

      switch (mode) {
        case "401":
          return 401
        case "500":
          return 500
        case "down":
          return "disconnect"
        case "busy-500":
          return repository?.[1] === "busy" &&
            (request.graphql?.operationName === "RepositoryPullRequests" ||
              request.graphql?.operationName === "SearchPullRequests")
            ? 500
            : undefined
        case "ok":
          return undefined
      }
    },
  })
})

export const serveFakeGitHub = (modeFile: string, readyFile: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const github = yield* startVerificationGitHub(modeFile)
        writeFileSync(readyFile, JSON.stringify({ port: Number(new URL(github.url).port) }))
        yield* Effect.never
      }),
    ),
  )
