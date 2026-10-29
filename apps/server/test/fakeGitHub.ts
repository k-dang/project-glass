import { NodeHttpServer, NodeHttpServerRequest } from "@effect/platform-node"
import { absurd, Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { fromGitHubSide, GitHubDiffSide } from "../src/github/diffSide.ts"
import { lineInPatch } from "../src/github/patchLines.ts"
import {
  type FakeCheck,
  type FakeComment,
  type FakeCommit,
  FakePullRequest,
  type FakePullRequestSeed,
  type FakeReview,
  type FakeReviewState,
  type FakeReviewThread,
  VIEWER,
} from "./fakePullRequest.ts"
import { author, connectionPage, inRepo, PAGE_SIZE, reviewRequestNodes } from "./fakeNodes.ts"
import { answerListing, ListingRequest } from "./fakePullRequestListing.ts"
import { startFakeGitRemote, type TrafficMeter, trafficMeter } from "./fakeGitRemote.ts"
import { basicAuthorization } from "../src/gitEnv.ts"

export interface FakeGraphQLError {
  readonly type: string
  readonly message: string
}

export type FakeFailure = number | "disconnect"

const PullRequestVariables = Schema.Struct({
  owner: Schema.String,
  name: Schema.String,
  number: Schema.Number,
})

type PullRequestVariables = typeof PullRequestVariables.Type

const FileContentsVariables = Schema.Struct({
  owner: Schema.String,
  name: Schema.String,
  expression: Schema.String,
})

type FileContentsVariables = typeof FileContentsVariables.Type

const AddDraftVariables = Schema.Struct({
  pullRequestId: Schema.String,
  path: Schema.String,
  line: Schema.Int,
  side: GitHubDiffSide,
  body: Schema.String,
})

type AddDraftVariables = typeof AddDraftVariables.Type

const ReviewEvent = Schema.Literals(["COMMENT", "APPROVE", "REQUEST_CHANGES"])

type ReviewEvent = typeof ReviewEvent.Type

const ReviewVariables = { event: ReviewEvent, body: Schema.NullOr(Schema.String) }

const SubmitReviewVariables = Schema.Struct({
  pullRequestReviewId: Schema.String,
  ...ReviewVariables,
})

const AddReviewVariables = Schema.Struct({ pullRequestId: Schema.String, ...ReviewVariables })

const reviewStates = {
  COMMENT: "COMMENTED",
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
} as const satisfies Record<ReviewEvent, FakeReviewState>

const ownPullRequestRefusals: Partial<Record<ReviewEvent, string>> = {
  APPROVE: "Can not approve your own pull request",
  REQUEST_CHANGES: "Can not request changes on your own pull request",
}

const unprocessable = (field: string, message: string) => ({
  data: { [field]: null },
  errors: [{ type: "UNPROCESSABLE", path: [field], message }],
})

const refuseReview = (field: string, pr: FakePullRequest, event: ReviewEvent) => {
  const refusal = pr.author === VIEWER.login ? ownPullRequestRefusals[event] : undefined

  return refusal === undefined ? undefined : unprocessable(field, refusal)
}

const reviewBodyHtml = (body: string | null) => (body === null ? "" : `<p>${body}</p>`)

const unresolvedNode = (id: string) => ({
  data: null,
  errors: [
    {
      type: "NOT_FOUND",
      path: ["node"],
      message: `Could not resolve to a node with the global id of '${id}'`,
    },
  ],
})

const unresolvedMutationNode = (field: string, id: string) => ({
  data: { [field]: null },
  errors: [
    {
      type: "NOT_FOUND",
      path: [field],
      message: `Could not resolve to a node with the global id of '${id}'.`,
    },
  ],
})

const unresolvedRepository = (owner: string, name: string) => ({
  data: { repository: null },
  errors: [
    {
      type: "NOT_FOUND",
      path: ["repository"],
      message: `Could not resolve to a Repository with the name '${owner}/${name}'.`,
    },
  ],
})

const GraphQLRequest = Schema.Union([
  Schema.Struct({
    operationName: Schema.Literals(["PullRequest", "TourInput"]),
    variables: PullRequestVariables,
  }),
  Schema.Struct({
    operationName: Schema.Literals([
      "PullRequestReviewThreads",
      "PullRequestComments",
      "PullRequestReviews",
      "PullRequestViewedFiles",
      "PullRequestReviewRequests",
    ] satisfies ReadonlyArray<keyof typeof connections>),
    variables: Schema.Struct({ id: Schema.String, after: Schema.NullOr(Schema.String) }),
  }),
  ListingRequest,
  Schema.Struct({
    operationName: Schema.Literal("PullRequestRevision"),
    variables: Schema.Struct({ id: Schema.String }),
  }),
  Schema.Struct({
    operationName: Schema.Literals(["MarkFileAsViewed", "UnmarkFileAsViewed"]),
    variables: Schema.Struct({ pullRequestId: Schema.String, path: Schema.String }),
  }),
  Schema.Struct({
    operationName: Schema.Literal("FileContents"),
    variables: FileContentsVariables,
  }),
  Schema.Struct({
    operationName: Schema.Literal("AddPullRequestReviewThread"),
    variables: AddDraftVariables,
  }),
  Schema.Struct({
    operationName: Schema.Literal("DraftState"),
    variables: Schema.Struct({ id: Schema.String }),
  }),
  Schema.Struct({
    operationName: Schema.Literal("UpdatePullRequestReviewComment"),
    variables: Schema.Struct({ id: Schema.String, body: Schema.String }),
  }),
  Schema.Struct({
    operationName: Schema.Literal("DeletePullRequestReviewComment"),
    variables: Schema.Struct({ id: Schema.String }),
  }),
  Schema.Struct({
    operationName: Schema.Literal("SubmitPullRequestReview"),
    variables: SubmitReviewVariables,
  }),
  Schema.Struct({
    operationName: Schema.Literal("AddPullRequestReview"),
    variables: AddReviewVariables,
  }),
  Schema.Struct({
    operationName: Schema.Literal("AddPullRequestReviewThreadReply"),
    variables: Schema.Struct({ pullRequestReviewThreadId: Schema.String, body: Schema.String }),
  }),
  Schema.Struct({
    operationName: Schema.Literals(["ResolveReviewThread", "UnresolveReviewThread"]),
    variables: Schema.Struct({ threadId: Schema.String }),
  }),
  Schema.Struct({
    operationName: Schema.Literal("RepositoryBranches"),
    variables: Schema.Struct({
      owner: Schema.String,
      name: Schema.String,
      after: Schema.NullOr(Schema.String),
    }),
  }),
])

export type FakeGraphQLRequest = typeof GraphQLRequest.Type

const commentNode = (comment: FakeComment) => ({
  id: comment.id,
  author: author(comment.author),
  bodyHTML: comment.bodyHtml,
  createdAt: comment.createdAt,
})

const DRAFT_CREATED_AT = "2026-01-01T00:00:00Z"

const reviewThreads = (pr: FakePullRequest) => [
  ...pr.reviewThreads.map((thread) =>
    threadNode(
      thread,
      thread.comments.map((comment) => ({
        id: comment.id,
        author: author(comment.author),
        body: comment.bodyHtml,
        bodyHTML: comment.bodyHtml,
        createdAt: comment.createdAt,
        state: "SUBMITTED",
        diffHunk: thread.diffHunk,
      })),
    ),
  ),
  ...(pr.pendingReview?.drafts ?? []).map((draft) =>
    threadNode({ ...draft, id: `PRRT_${draft.id}`, resolved: false }, [
      {
        id: draft.id,
        author: author(VIEWER.login),
        body: draft.body,
        bodyHTML: `<p>${draft.body}</p>`,
        createdAt: DRAFT_CREATED_AT,
        state: "PENDING",
        diffHunk: draft.diffHunk,
      },
    ]),
  ),
]

const threadNode = <Comment>(
  thread: Omit<FakeReviewThread, "comments" | "diffHunk">,
  comments: ReadonlyArray<Comment>,
) => ({
  id: thread.id,
  isResolved: thread.resolved,
  isOutdated: thread.outdated,
  path: thread.path,
  line: thread.outdated ? null : (thread.line ?? 1),
  originalLine: thread.line ?? 1,
  diffSide: thread.side,
  subjectType: thread.line === undefined ? "FILE" : "LINE",
  comments: { nodes: comments },
})

const latestOpinionatedReviews = (pr: FakePullRequest) => {
  const latest = new Map<string | null, FakeReview>()

  for (const review of pr.reviews) {
    if (review.state !== "COMMENTED") latest.set(review.author, review)
  }

  return [...latest.values()].map((review) => ({
    author: author(review.author),
    state: review.state,
  }))
}

const checkRunNode = ({
  status = "COMPLETED",
  ...check
}: Extract<FakeCheck, { kind: "CheckRun" }>) => ({
  __typename: "CheckRun",
  name: check.name,
  status,
  conclusion: status === "COMPLETED" ? (check.conclusion ?? "SUCCESS") : null,
  detailsUrl: check.url ?? null,
  checkSuite: {
    workflowRun: check.workflow === undefined ? null : { workflow: { name: check.workflow } },
  },
})

const checkContextNode = (check: FakeCheck) =>
  check.kind === "StatusContext"
    ? {
        __typename: "StatusContext",
        context: check.context,
        state: check.state,
        targetUrl: check.url ?? null,
      }
    : checkRunNode(check)

const connections = {
  PullRequestViewedFiles: (pr: FakePullRequest) =>
    pr.changedFiles.map((file) => ({
      path: file.path,
      viewerViewedState: pr.viewedPaths.has(file.path)
        ? "VIEWED"
        : file.viewerViewedState === "DISMISSED"
          ? "DISMISSED"
          : "UNVIEWED",
    })),
  PullRequestReviewRequests: reviewRequestNodes,
  PullRequestReviewThreads: reviewThreads,
  PullRequestComments: (pr: FakePullRequest) => pr.comments.map(commentNode),
  PullRequestReviews: (pr: FakePullRequest) => [
    ...pr.reviews.map((review) => ({
      id: review.id,
      author: author(review.author),
      state: review.state,
      bodyHTML: review.bodyHtml,
      submittedAt: review.submittedAt,
    })),
    ...(pr.pendingReview === undefined
      ? []
      : [
          {
            id: pr.pendingReview.id,
            author: author(VIEWER.login),
            state: "PENDING",
            bodyHTML: "",
            submittedAt: null,
          },
        ]),
  ],
} satisfies Record<string, (pr: FakePullRequest) => ReadonlyArray<unknown>>

const PullRequestFilesParams = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  number: Schema.NumberFromString,
  per_page: Schema.optional(Schema.NumberFromString),
  page: Schema.optional(Schema.NumberFromString),
})

const TreeParams = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  sha: Schema.String,
  recursive: Schema.Literal("1"),
})

const BLOB_TEXT_LIMIT = 512_000

const blob = (contents: string) => {
  const bytes = Buffer.from(contents)
  const isBinary = contents.includes("\u0000")

  return {
    __typename: "Blob",
    isBinary,
    isTruncated: !isBinary && bytes.length > BLOB_TEXT_LIMIT,
    text: isBinary ? null : bytes.subarray(0, BLOB_TEXT_LIMIT).toString(),
  }
}

const treeEntries = (commit: FakeCommit) => {
  const directories = new Set(
    Object.keys(commit.files).flatMap((path) =>
      path
        .split("/")
        .slice(0, -1)
        .map((_, index, parts) => parts.slice(0, index + 1).join("/")),
    ),
  )

  return [
    ...[...directories].map((path) => ({ path, type: "tree" })),
    ...Object.keys(commit.files).map((path) => ({ path, type: "blob" })),
  ].toSorted((a, b) => (a.path < b.path ? -1 : 1))
}

const blobSha = (contents: string) => {
  const bytes = Buffer.from(contents)

  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
}

export interface FakeGitHub {
  readonly url: string
  readonly gitUrl: string
  seedPullRequest(seed: FakePullRequestSeed): FakePullRequest
  seedBranches(
    repository: { readonly owner: string; readonly repo: string },
    seed: { readonly defaultBranch: string | null; readonly branches: ReadonlyArray<string> },
  ): void
  failNext(failure: FakeFailure): void
  failNextGraphQL(error: FakeGraphQLError): void
  beforeNext(path: string, action: () => void): void
  readonly gitTraffic: TrafficMeter
  readonly unavailableRepositories: Set<string>
  readonly timingOutRepositories: Set<string>
  readonly gitRefusedRepositories: Set<string>
  readonly graphQLRequests: ReadonlyArray<FakeGraphQLRequest>
}

export interface FakeGitHubRequest {
  readonly method: string
  readonly path: string
  readonly graphql: FakeGraphQLRequest | undefined
}

interface FakeGitHubOptions {
  readonly git?: boolean
  readonly beforeRequest?: (
    request: FakeGitHubRequest,
    github: FakeGitHub,
  ) => FakeFailure | undefined
}

const branchesKey = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase()

export const startFakeGitHub = Effect.fnUntraced(function* (options: FakeGitHubOptions = {}) {
  const failures: Array<FakeFailure> = []
  const graphQLFailures: Array<FakeGraphQLError> = []
  const gitTraffic = trafficMeter()
  const pullRequests: Array<FakePullRequest> = []
  const unavailableRepositories = new Set<string>()
  const timingOutRepositories = new Set<string>()
  const gitRefusedRepositories = new Set<string>()

  const branches = new Map<
    string,
    { readonly defaultBranch: string | null; readonly branches: ReadonlyArray<string> }
  >()

  const gitRemote = options.git
    ? yield* startFakeGitRemote({
        traffic: gitTraffic,
        unavailableRepositories,
        timingOutRepositories,
        gitRefusedRepositories,
      })
    : undefined

  const graphQLRequests: Array<FakeGraphQLRequest> = []
  const beforeActions: Array<{ readonly path: string; readonly action: () => void }> = []
  let lastId = 0
  const nextId = (prefix: string) => `${prefix}_${++lastId}`
  let lastTime = 0
  const now = () => new Date((lastTime = Math.max(Date.now(), lastTime + 1))).toISOString()

  const nextNumber = (owner: string, repo: string) => {
    const taken = pullRequests.flatMap((other) =>
      other.owner === owner && other.repo === repo ? [other.number] : [],
    )

    return Math.max(0, ...taken) + 1
  }

  const pullRequestById = (id: string) => pullRequests.find((candidate) => candidate.id === id)

  const commitIn = (owner: string, repo: string, sha: string) =>
    pullRequests.find((pr) => inRepo(owner, repo)(pr) && pr.commits.has(sha))?.commits.get(sha)

  // GitHub takes the token as a Bearer token, or as Basic credentials from git.
  const validCredentials = new Set([`Bearer ${VIEWER.token}`, basicAuthorization(VIEWER.token)])

  const FailuresAndAuth = HttpRouter.middleware(
    (route) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const pathname = new URL(request.url, "http://fake").pathname
        const before = beforeActions.findIndex(({ path }) => pathname.startsWith(path))

        if (before !== -1) beforeActions.splice(before, 1)[0]?.action()

        const graphql =
          options.beforeRequest !== undefined &&
          request.method === "POST" &&
          pathname === "/graphql"
            ? yield* Effect.orDie(HttpServerRequest.schemaBodyJson(GraphQLRequest))
            : undefined

        const failure =
          options.beforeRequest?.({ method: request.method, path: pathname, graphql }, fake) ??
          failures.shift()

        if (failure === "disconnect") {
          NodeHttpServerRequest.toIncomingMessage(request).socket.destroy()

          return HttpServerResponse.empty()
        }

        if (failure !== undefined) return HttpServerResponse.empty({ status: failure })

        if (!validCredentials.has(request.headers["authorization"] ?? "")) {
          return HttpServerResponse.jsonUnsafe({ message: "Bad credentials" }, { status: 401 })
        }

        return yield* route
      }),
    { global: true },
  )

  const pullRequestQuery = (variables: PullRequestVariables) => {
    const answer = pullRequestAnswer(variables)

    return { ...answer, data: { viewer: author(VIEWER.login), ...answer.data } }
  }

  const pullRequestAnswer = ({ owner, name, number }: PullRequestVariables) => {
    const matches = inRepo(owner, name)

    if (!pullRequests.some(matches)) {
      return unresolvedRepository(owner, name)
    }

    const pr = pullRequests.find((candidate) => matches(candidate) && candidate.number === number)

    if (pr === undefined) {
      return {
        data: { repository: { pullRequest: null } },
        errors: [
          {
            type: "NOT_FOUND",
            path: ["repository", "pullRequest"],
            message: `Could not resolve to a PullRequest with the number of ${number}.`,
          },
        ],
      }
    }

    return {
      data: {
        repository: {
          pullRequest: {
            id: pr.id,
            repository: { owner: { login: pr.owner }, name: pr.repo },
            number: pr.number,
            url: pr.url,
            title: pr.title,
            author: author(pr.author),
            baseRefName: pr.baseBranch,
            headRefName: pr.headBranch,
            baseRefOid: pr.base.sha,
            headRefOid: pr.head.sha,
            updatedAt: pr.updatedAt,
            state: pr.state,
            isDraft: pr.isDraft,
            bodyHTML: pr.bodyHtml,
            body: pr.body,
            viewerDidAuthor: pr.author === VIEWER.login,
            reviewDecision: pr.reviewDecision,
            mergeable: pr.mergeable,
            latestOpinionatedReviews: { nodes: latestOpinionatedReviews(pr) },
            reviewRequests: { nodes: reviewRequestNodes(pr) },
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup:
                      pr.checks === null && pr.checkContexts.length === 0
                        ? null
                        : { contexts: { nodes: pr.checkContexts.map(checkContextNode) } },
                  },
                },
              ],
            },
          },
        },
      },
    }
  }

  const fileContentsQuery = ({ owner, name, expression }: FileContentsVariables) => {
    if (!pullRequests.some(inRepo(owner, name))) {
      return unresolvedRepository(owner, name)
    }

    const [sha = "", path = ""] = expression.split(/:(.*)/s)
    const contents = commitIn(owner, name, sha)?.files[path]

    return { data: { repository: { object: contents === undefined ? null : blob(contents) } } }
  }

  const draftById = (id: string) => {
    for (const pr of pullRequests) {
      const index = pr.pendingReview?.drafts.findIndex((draft) => draft.id === id) ?? -1

      if (index !== -1) return { pr, index }
    }

    return undefined
  }

  const publishedCommentById = (id: string) => {
    for (const pr of pullRequests) {
      for (const [threadIndex, thread] of pr.reviewThreads.entries()) {
        const index = thread.comments.findIndex((comment) => comment.id === id)

        if (index !== -1) return { pr, threadIndex, thread, index }
      }
    }

    return undefined
  }

  const draftState = ({ id }: { readonly id: string }) => {
    if (draftById(id) !== undefined) return { data: { node: { state: "PENDING" } } }

    if (publishedCommentById(id) !== undefined) return { data: { node: { state: "SUBMITTED" } } }

    return unresolvedNode(id)
  }

  const editPublished = (
    id: string,
    edit: (comments: Array<FakeComment>, index: number) => void,
  ) => {
    const found = publishedCommentById(id)

    if (found === undefined) return false

    const comments = [...found.thread.comments]
    edit(comments, found.index)
    found.pr.reviewThreads[found.threadIndex] = { ...found.thread, comments }

    return true
  }

  const addDraft = ({ pullRequestId, ...draft }: AddDraftVariables) => {
    const pr = pullRequestById(pullRequestId)

    if (pr === undefined) return unresolvedMutationNode("addPullRequestReviewThread", pullRequestId)

    const patch = pr.changedFiles.find((file) => file.path === draft.path)?.patch

    if (
      patch === undefined ||
      lineInPatch(patch, fromGitHubSide(draft.side), draft.line) === null
    ) {
      return { data: { addPullRequestReviewThread: { thread: null } } }
    }

    const added = pr.addDraft({ ...draft, diffHunk: patch })

    return {
      data: {
        addPullRequestReviewThread: {
          thread: {
            path: added.path,
            line: added.line,
            diffSide: added.side,
            comments: { nodes: [{ id: added.id, body: added.body }] },
          },
        },
      },
    }
  }

  const updateDraft = ({ id, body }: { readonly id: string; readonly body: string }) => {
    const field = "updatePullRequestReviewComment"

    if (body.trim() === "") return unprocessable(field, "Body can't be blank")

    const edited = editPublished(id, (comments, index) => {
      comments[index] = { ...comments[index]!, bodyHtml: `<p>${body}</p>` }
    })

    if (edited) return { data: { [field]: { clientMutationId: null } } }

    const found = draftById(id)

    if (found === undefined) return unresolvedMutationNode(field, id)

    const drafts = found.pr.pendingReview!.drafts
    drafts[found.index] = { ...drafts[found.index]!, body }

    return { data: { [field]: { clientMutationId: null } } }
  }

  const deleteDraft = ({ id }: { readonly id: string }) => {
    const field = "deletePullRequestReviewComment"

    if (editPublished(id, (comments, index) => comments.splice(index, 1))) {
      return { data: { [field]: { clientMutationId: null } } }
    }

    const found = draftById(id)

    if (found === undefined) return unresolvedMutationNode(field, id)

    const { pr, index } = found
    pr.pendingReview!.drafts.splice(index, 1)

    if (pr.pendingReview!.drafts.length === 0) pr.pendingReview = undefined

    return { data: { [field]: { clientMutationId: null } } }
  }

  const submitReview = ({
    pullRequestReviewId,
    event,
    body,
  }: typeof SubmitReviewVariables.Type) => {
    const field = "submitPullRequestReview"
    const pr = pullRequests.find((candidate) => candidate.pendingReview?.id === pullRequestReviewId)

    if (pr === undefined) return unresolvedMutationNode(field, pullRequestReviewId)

    const refused = refuseReview(field, pr, event)

    if (refused !== undefined) return refused

    pr.submitPendingReview(reviewStates[event], reviewBodyHtml(body))

    return { data: { [field]: { clientMutationId: null } } }
  }

  const addReview = ({ pullRequestId, event, body }: typeof AddReviewVariables.Type) => {
    const field = "addPullRequestReview"
    const pr = pullRequestById(pullRequestId)

    if (pr === undefined) return unresolvedMutationNode(field, pullRequestId)

    if (pr.pendingReview !== undefined) {
      return unprocessable(field, "User can only have one pending review per pull request")
    }

    const refused = refuseReview(field, pr, event)

    if (refused !== undefined) return refused

    if (event === "COMMENT" && body === null) return unprocessable(field, "")

    pr.addReview({
      author: VIEWER.login,
      state: reviewStates[event],
      bodyHtml: reviewBodyHtml(body),
    })

    return { data: { [field]: { clientMutationId: null } } }
  }

  const reply = ({
    pullRequestReviewThreadId,
    body,
  }: {
    readonly pullRequestReviewThreadId: string
    readonly body: string
  }) => {
    const field = "addPullRequestReviewThreadReply"

    if (body.trim() === "") return { data: { [field]: { comment: null } } }

    for (const pr of pullRequests) {
      const added = pr.reply(pullRequestReviewThreadId, body)

      if (added === undefined) continue

      const { comment, pending } = added

      return {
        data: {
          [field]: {
            comment: { ...commentNode(comment), state: pending ? "PENDING" : "SUBMITTED" },
          },
        },
      }
    }

    return unresolvedMutationNode(field, pullRequestReviewThreadId)
  }

  const setThreadResolved = (
    operationName: "ResolveReviewThread" | "UnresolveReviewThread",
    threadId: string,
  ) => {
    const resolved = operationName === "ResolveReviewThread"
    const field = resolved ? "resolveReviewThread" : "unresolveReviewThread"

    for (const pr of pullRequests) {
      const updated = pr.setResolved(threadId, resolved)

      if (updated === undefined) continue

      return { data: { [field]: { thread: { isResolved: updated } } } }
    }

    return unresolvedMutationNode(field, threadId)
  }

  const answerGraphQL = (request: typeof GraphQLRequest.Type) => {
    switch (request.operationName) {
      case "PullRequest":
      case "TourInput":
        return pullRequestQuery(request.variables)
      case "PullRequestReviewThreads":
      case "PullRequestComments":
      case "PullRequestReviews":
      case "PullRequestViewedFiles":
      case "PullRequestReviewRequests": {
        const { id, after } = request.variables
        const pr = pullRequestById(id)

        if (pr === undefined) return unresolvedNode(id)

        const page = connectionPage<unknown>(connections[request.operationName](pr), after)

        return { data: { node: { connection: page } } }
      }

      case "RepositoryPullRequests":
      case "SearchPullRequests":
      case "PullRequestChecks":
      case "QueuedPullRequests":
        return answerListing(request, pullRequests, unavailableRepositories, timingOutRepositories)

      case "PullRequestRevision": {
        const pr = pullRequestById(request.variables.id)

        if (pr === undefined) return unresolvedNode(request.variables.id)

        const pending = pr.pendingReview === undefined ? [] : [{ id: pr.pendingReview.id }]

        return {
          data: {
            node: {
              baseRefOid: pr.base.sha,
              headRefOid: pr.head.sha,
              updatedAt: pr.updatedAt,
              reviews: { nodes: pending },
            },
          },
        }
      }

      case "MarkFileAsViewed":
      case "UnmarkFileAsViewed": {
        const { pullRequestId, path } = request.variables
        const pr = pullRequestById(pullRequestId)

        const field =
          request.operationName === "MarkFileAsViewed" ? "markFileAsViewed" : "unmarkFileAsViewed"

        if (pr === undefined) return unresolvedMutationNode(field, pullRequestId)

        if (!pr.changedFiles.some((file) => file.path === path)) {
          return unprocessable(field, "File is not part of the pull request")
        }

        if (request.operationName === "MarkFileAsViewed") pr.viewedPaths.add(path)
        else pr.viewedPaths.delete(path)

        return { data: { [field]: { clientMutationId: null } } }
      }

      case "FileContents":
        return fileContentsQuery(request.variables)

      case "AddPullRequestReviewThread":
        return addDraft(request.variables)

      case "DraftState":
        return draftState(request.variables)

      case "UpdatePullRequestReviewComment":
        return updateDraft(request.variables)

      case "DeletePullRequestReviewComment":
        return deleteDraft(request.variables)

      case "SubmitPullRequestReview":
        return submitReview(request.variables)

      case "AddPullRequestReview":
        return addReview(request.variables)

      case "AddPullRequestReviewThreadReply":
        return reply(request.variables)

      case "ResolveReviewThread":
      case "UnresolveReviewThread":
        return setThreadResolved(request.operationName, request.variables.threadId)

      case "RepositoryBranches": {
        const { owner, name, after } = request.variables
        const seeded = branches.get(branchesKey(owner, name))

        if (seeded === undefined) return unresolvedRepository(owner, name)

        return {
          data: {
            repository: {
              defaultBranchRef:
                seeded.defaultBranch === null ? null : { name: seeded.defaultBranch },
              refs: connectionPage(
                seeded.branches.map((branch) => ({ name: branch })),
                after,
              ),
            },
          },
        }
      }

      default:
        return absurd<never>(request)
    }
  }

  const pullRequestFiles = Effect.gen(function* () {
    const params = yield* Effect.orDie(HttpRouter.schemaParams(PullRequestFilesParams))
    const perPage = Math.min(params.per_page ?? 30, PAGE_SIZE)
    const page = params.page ?? 1

    const pr = pullRequests.find(
      (candidate) =>
        inRepo(params.owner, params.repo)(candidate) && candidate.number === params.number,
    )

    if (pr === undefined) {
      return HttpServerResponse.jsonUnsafe({ message: "Not Found" }, { status: 404 })
    }

    const files = pr.changedFiles.slice((page - 1) * perPage, page * perPage).map((file) => {
      const commit = file.status === "removed" ? pr.base : pr.head
      const contents = commit.files[file.path]

      if (contents === undefined) {
        throw new Error(`Changed file ${file.path} isn't in commit ${commit.sha}`)
      }

      const additions = file.additions ?? 0
      const deletions = file.deletions ?? 0

      return {
        sha: blobSha(contents),
        filename: file.path,
        status: file.status,
        additions,
        deletions,
        patch: file.patch,
        previous_filename: file.previousPath,
      }
    })

    return HttpServerResponse.jsonUnsafe(files)
  })

  const gitTree = Effect.gen(function* () {
    const params = yield* Effect.orDie(HttpRouter.schemaParams(TreeParams))
    const commit = commitIn(params.owner, params.repo, params.sha)

    if (commit === undefined) {
      return HttpServerResponse.jsonUnsafe(
        { message: "Invalid object requested. SHA must identify a commit or a tree." },
        { status: 422 },
      )
    }

    return HttpServerResponse.jsonUnsafe({
      tree: treeEntries(commit),
      truncated: false,
    })
  })

  const Routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/user/teams",
      HttpServerResponse.jsonUnsafe(
        VIEWER.teams.map((team) => {
          const [owner, slug] = team.split("/")

          return { slug, organization: { login: owner } }
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/user",
      HttpServerResponse.jsonUnsafe({ login: VIEWER.login, id: VIEWER.id }),
    ),
    HttpRouter.add(
      "POST",
      "/graphql",
      Effect.gen(function* () {
        const request = yield* Effect.orDie(HttpServerRequest.schemaBodyJson(GraphQLRequest))
        graphQLRequests.push(request)

        const failure = graphQLFailures.shift()

        if (failure !== undefined) {
          return HttpServerResponse.jsonUnsafe({ data: null, errors: [{ ...failure, path: [] }] })
        }

        return HttpServerResponse.jsonUnsafe(answerGraphQL(request))
      }),
    ),
    HttpRouter.add("GET", "/repos/:owner/:repo/pulls/:number/files", pullRequestFiles),
    HttpRouter.add("GET", "/repos/:owner/:repo/git/trees/:sha", gitTree),
    ...(gitRemote === undefined ? [] : [gitRemote.route]),
    FailuresAndAuth,
  )

  const server = createServer()

  const services = yield* Layer.build(
    HttpRouter.serve(Routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(() => server, { port: 0, host: "127.0.0.1" })),
    ),
  )

  // Failed responses can leave fetch connections open until their keep-alive timeout.
  yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()))

  const url = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address)

  const fake: FakeGitHub = {
    url,
    gitUrl: `${url}/git`,
    seedPullRequest: (seed) => {
      const pr = new FakePullRequest(nextId, now, seed, nextNumber, gitRemote?.publish)

      pullRequests.push(pr)

      return pr
    },
    seedBranches: ({ owner, repo }, seed) => {
      branches.set(branchesKey(owner, repo), seed)
    },
    failNext: (failure) => {
      failures.push(failure)
    },
    failNextGraphQL: (error) => {
      graphQLFailures.push(error)
    },
    beforeNext: (path, action) => {
      beforeActions.push({ path, action })
    },
    gitTraffic,
    unavailableRepositories,
    timingOutRepositories,
    gitRefusedRepositories,
    graphQLRequests,
  }

  return fake
})
