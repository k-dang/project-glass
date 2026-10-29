import {
  ActivityPullRequest,
  ChangedFile,
  Discussions,
  type Draft,
  PullRequest,
  PullRequestRef,
  PullRequestWorkspace,
  Revision,
  TextPatch,
  type Tour,
  Viewer,
} from "@glass/contracts"
import { DateTime } from "effect"

export const revision = new Revision({ base: "b0", head: "h1" })

export const hunks = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c"

export const changedFile = (
  path: string,
  patch: ChangedFile["patch"] = TextPatch.make({ hunks }),
) =>
  new ChangedFile({
    path,
    previousPath: null,
    changeType: "modified",
    additions: 1,
    deletions: 1,
    patch,
  })

export const tourChapter = (title: string, paths: ReadonlyArray<string>) => ({
  title,
  explanation: `${title} explained.`,
  files: paths.map((path) => ({ path, summary: `${path} summary` })),
})

export const savedTour = (
  chapters: Tour["chapters"],
  everythingElse: ReadonlyArray<string> = [],
): Tour => ({
  revision,
  writtenAt: DateTime.makeUnsafe("2026-10-22T00:00:00Z"),
  intent: "Greet people by name.",
  chapters,
  everythingElse,
})

export const viewer = new Viewer({
  login: "octocat",
  avatarUrl: "https://avatars.githubusercontent.com/octocat",
})

export const pullRequestRef = new PullRequestRef({
  owner: "octo-org",
  repo: "hello-world",
  number: 42,
})

export const recordedPullRequest = new ActivityPullRequest({
  ref: pullRequestRef,
  title: "Greet the world",
  revision,
})

export const pullRequestFields = {
  id: "PR_1",
  ref: pullRequestRef,
  url: "https://github.com/octo-org/hello-world/pull/42",
  title: "Greet the world",
  author: "hubot",
  baseBranch: "main",
  headBranch: "greeting",
  state: "open",
  descriptionHtml: "",
  viewerIsAuthor: false,
  approval: null,
  reviewers: [],
  checks: [],
  mergeable: "mergeable",
} satisfies ConstructorParameters<typeof PullRequest>[0]

export const workspace = (
  drafts: ReadonlyArray<Draft> = [],
  changes: {
    readonly files?: ReadonlyArray<ChangedFile>
    readonly viewedPaths?: ReadonlyArray<string>
    readonly revision?: Revision
  } = {},
) =>
  new PullRequestWorkspace({
    viewer,
    pullRequest: new PullRequest(pullRequestFields),
    revision: changes.revision ?? revision,
    updatedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
    files: changes.files ?? [],
    viewedPaths: changes.viewedPaths ?? [],
    discussions: new Discussions({ onLines: [], outdated: [], timeline: [] }),
    drafts,
  })
