import { absurd, Schema } from "effect"
import {
  author,
  checkContextsNode,
  connectionPage,
  inRepo,
  latestOpinionatedReviews,
  reviewRequestNodes,
} from "./fakeNodes.ts"
import { type FakePullRequest, VIEWER } from "./fakePullRequest.ts"

export const ListingRequest = Schema.Union([
  Schema.Struct({
    operationName: Schema.Literal("RepositoryPullRequests"),
    variables: Schema.Struct({
      owner: Schema.String,
      name: Schema.String,
      viewerLogin: Schema.String,
      after: Schema.NullOr(Schema.String),
    }),
  }),
  Schema.Struct({
    operationName: Schema.Literal("SearchPullRequests"),
    variables: Schema.Struct({
      query: Schema.String,
      viewerLogin: Schema.String,
      after: Schema.NullOr(Schema.String),
    }),
  }),
  Schema.Struct({
    operationName: Schema.Literal("PullRequestObservations"),
    variables: Schema.Struct({ ids: Schema.Array(Schema.String) }),
  }),
  Schema.Struct({
    operationName: Schema.Literal("PullRequestAttention"),
    variables: Schema.Struct({ ids: Schema.Array(Schema.String) }),
  }),
  Schema.Struct({
    operationName: Schema.Literal("SubscribedPullRequests"),
    variables: Schema.Struct({ ids: Schema.Array(Schema.String) }),
  }),
  Schema.Struct({
    operationName: Schema.Literal("QueuedPullRequests"),
    variables: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number])),
  }),
  Schema.Struct({
    operationName: Schema.Literal("EndedBranchPullRequests"),
    variables: Schema.Record(Schema.String, Schema.String),
  }),
])

const checksNode = (pr: FakePullRequest) => ({
  nodes: [{ commit: { statusCheckRollup: pr.checks === null ? null : { state: pr.checks } } }],
})

const mergeStateStatus = (pr: FakePullRequest) => {
  if (pr.isDraft) return "DRAFT"

  if (pr.mergeable === "CONFLICTING") return "DIRTY"

  if (pr.mergeable === "UNKNOWN") return "UNKNOWN"

  if (pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewDecision === "CHANGES_REQUESTED") {
    return "BLOCKED"
  }

  if (pr.mergeStateStatus === "BEHIND") return "BEHIND"

  return pr.checks === null || pr.checks === "SUCCESS" ? "CLEAN" : "UNSTABLE"
}

const attentionNode = (pr: FakePullRequest) => ({
  id: pr.id,
  mergeStateStatus: mergeStateStatus(pr),
  mergeable: pr.mergeable,
  latestOpinionatedReviews: { nodes: latestOpinionatedReviews(pr) },
  reviewThreads: {
    nodes: pr.reviewThreads.map((reviewThread) => ({
      isResolved: reviewThread.resolved,
      comments: {
        nodes: reviewThread.comments
          .slice(-1)
          .map((comment) => ({ viewerDidAuthor: comment.author === VIEWER.login })),
      },
    })),
  },
  commits: checkContextsNode(pr),
})

const text = (html: string) => html.replaceAll(/<[^>]+>/g, "")

const subscribedNode = (pr: FakePullRequest) => ({
  ...attentionNode(pr),
  headRefOid: pr.head.sha,
  baseRefOid: pr.base.sha,
  reviewThreads: {
    nodes: pr.reviewThreads.map((reviewThread) => ({
      id: reviewThread.id,
      isResolved: reviewThread.resolved,
      path: reviewThread.path,
      line: reviewThread.line ?? null,
      comments: {
        nodes: reviewThread.comments.map((comment) => ({
          id: comment.id,
          body: text(comment.bodyHtml),
          author: author(comment.author),
          authorAssociation: comment.authorAssociation ?? "NONE",
          viewerDidAuthor: comment.author === VIEWER.login,
        })),
      },
    })),
  },
})

const candidatesPage = (
  matched: ReadonlyArray<FakePullRequest>,
  viewerLogin: string,
  after: string | null,
) => {
  const page = connectionPage(
    matched.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    after,
  )

  return {
    pageInfo: page.pageInfo,
    nodes: page.nodes.map((pr) => ({
      id: pr.id,
      number: pr.number,
      repository: { owner: { login: pr.owner }, name: pr.repo },
      url: pr.url,
      title: pr.title,
      author: author(pr.author),
      updatedAt: pr.updatedAt,
      headRefOid: pr.head.sha,
      headRefName: pr.headBranch,
      isCrossRepository: pr.isCrossRepository,
      isDraft: pr.isDraft,
      state: pr.state,
      viewerDidAuthor: pr.author === VIEWER.login,
      viewerSubmittedReviews: {
        nodes: pr.reviews
          .filter((review) => review.author?.toLowerCase() === viewerLogin.toLowerCase())
          .slice(0, 1)
          .map((review) => ({ id: review.id })),
      },
      pendingReviews: {
        nodes:
          pr.pendingReview === undefined
            ? []
            : [{ comments: { totalCount: pr.pendingReview.drafts.length } }],
      },
      reviewRequests: connectionPage(reviewRequestNodes(pr), null),
    })),
  }
}

const ignoredSearchTerms = new Set(["is:pr", "sort:updated-desc"])

const searchFilter = (term: string): ((pr: FakePullRequest) => boolean) => {
  const repository = /^repo:([^/]+)\/(.+)$/.exec(term)

  if (repository !== null) return inRepo(repository[1]!, repository[2]!)

  const updated = /^updated:>=(.+)$/.exec(term)

  if (updated !== null) return (pr) => Date.parse(pr.updatedAt) >= Date.parse(updated[1]!)

  if (ignoredSearchTerms.has(term)) return () => true

  throw new Error(`The fake can't search for ${term}`)
}

const repositoryFailure = {
  data: null,
  errors: [{ type: "INTERNAL", path: [], message: "Something went wrong" }],
}

const queuedNode = (pr: FakePullRequest) => ({
  id: pr.id,
  number: pr.number,
  url: pr.url,
  title: pr.title,
  author: author(pr.author),
  updatedAt: pr.updatedAt,
  isDraft: pr.isDraft,
  state: pr.state,
  baseRefOid: pr.base.sha,
  headRefOid: pr.head.sha,
  mergedAt: pr.mergedAt,
  closedAt: pr.closedAt,
  repository: { owner: { login: pr.owner }, name: pr.repo },
  commits: checksNode(pr),
})

interface QueuedAnswer {
  readonly value: { readonly pullRequest: ReturnType<typeof queuedNode> | null } | null
  readonly error?: {
    readonly type?: string
    readonly path: ReadonlyArray<string>
    readonly message: string
  }
}

const queuedPullRequest = (
  alias: string,
  owner: string,
  name: string,
  number: number,
  pullRequests: ReadonlyArray<FakePullRequest>,
  unavailableRepositories: ReadonlySet<string>,
  timingOutRepositories: ReadonlySet<string>,
): QueuedAnswer => {
  if (timingOutRepositories.has(`${owner}/${name}`)) {
    return {
      value: null,
      error: {
        path: [alias],
        message:
          "Something went wrong while executing your query. This may be the result of a timeout.",
      },
    }
  }

  if (unavailableRepositories.has(`${owner}/${name}`)) {
    return {
      value: null,
      error: {
        type: "FORBIDDEN",
        path: [alias],
        message: "Resource protected by organization SAML enforcement.",
      },
    }
  }

  if (!pullRequests.some(inRepo(owner, name))) {
    return {
      value: null,
      error: {
        type: "NOT_FOUND",
        path: [alias],
        message: `Could not resolve to a Repository with the name '${owner}/${name}'.`,
      },
    }
  }

  const pr = pullRequests.find(
    (candidate) => inRepo(owner, name)(candidate) && candidate.number === number,
  )

  if (pr === undefined) {
    return {
      value: { pullRequest: null },
      error: {
        type: "NOT_FOUND",
        path: [alias, "pullRequest"],
        message: `Could not resolve to a PullRequest with the number of ${number}.`,
      },
    }
  }

  return { value: { pullRequest: queuedNode(pr) } }
}

const queuedPullRequests = (
  variables: Readonly<Record<string, string | number>>,
  pullRequests: ReadonlyArray<FakePullRequest>,
  unavailableRepositories: ReadonlySet<string>,
  timingOutRepositories: ReadonlySet<string>,
) => {
  const answers = Array.from(
    { length: Object.keys(variables).filter((name) => name.startsWith("owner")).length },
    (_, index) =>
      [
        `lookup${index}`,
        queuedPullRequest(
          `lookup${index}`,
          String(variables[`owner${index}`]),
          String(variables[`name${index}`]),
          Number(variables[`number${index}`]),
          pullRequests,
          unavailableRepositories,
          timingOutRepositories,
        ),
      ] as const,
  )

  const data = Object.fromEntries(answers.map(([alias, { value }]) => [alias, value]))
  const errors = answers.flatMap(([, { error }]) => (error === undefined ? [] : [error]))

  return errors.length === 0 ? { data } : { data, errors }
}

const endedBranchPullRequests = (
  variables: Readonly<Record<string, string>>,
  pullRequests: ReadonlyArray<FakePullRequest>,
) => ({
  data: Object.fromEntries(
    Array.from(
      { length: Object.keys(variables).filter((name) => name.startsWith("owner")).length },
      (_, index) => {
        const owner = variables[`owner${index}`]!
        const name = variables[`name${index}`]!
        const branch = variables[`branch${index}`]

        const nodes = pullRequests
          .filter(
            (pr) => inRepo(owner, name)(pr) && pr.headBranch === branch && pr.state !== "OPEN",
          )
          .toSorted((a, b) => b.number - a.number)
          .map((pr) => ({
            number: pr.number,
            url: pr.url,
            title: pr.title,
            state: pr.state,
            isCrossRepository: pr.isCrossRepository,
            createdAt: pr.createdAt,
            mergedAt: pr.mergedAt,
            closedAt: pr.closedAt,
          }))

        return [`lookup${index}`, { pullRequests: { nodes } }]
      },
    ),
  ),
})

interface ListingFaults {
  readonly unavailableRepositories: ReadonlySet<string>
  readonly timingOutRepositories: ReadonlySet<string>
  readonly unindexedPullRequests: ReadonlySet<string>
}

export const answerListing = (
  request: typeof ListingRequest.Type,
  pullRequests: ReadonlyArray<FakePullRequest>,
  { unavailableRepositories, timingOutRepositories, unindexedPullRequests }: ListingFaults,
) => {
  switch (request.operationName) {
    case "RepositoryPullRequests": {
      const { owner, name, viewerLogin, after } = request.variables

      if (unavailableRepositories.has(`${owner}/${name}`)) return repositoryFailure

      const matched = pullRequests.filter((pr) => inRepo(owner, name)(pr) && pr.state === "OPEN")

      return { data: { repository: { pullRequests: candidatesPage(matched, viewerLogin, after) } } }
    }

    case "SearchPullRequests": {
      const { query, viewerLogin, after } = request.variables
      const repository = /repo:(\S+)/.exec(query)?.[1]

      if (repository !== undefined && unavailableRepositories.has(repository)) {
        return repositoryFailure
      }

      const filters = query.split(" ").map(searchFilter)

      const matched = pullRequests.filter(
        (pr) => !unindexedPullRequests.has(pr.id) && filters.every((matches) => matches(pr)),
      )

      return { data: { search: candidatesPage(matched, viewerLogin, after) } }
    }

    case "PullRequestObservations":
      return {
        data: {
          nodes: request.variables.ids.map((id) => {
            const pr = pullRequests.find((candidate) => candidate.id === id)

            return pr === undefined
              ? null
              : { id: pr.id, state: pr.state, headRefOid: pr.head.sha, commits: checksNode(pr) }
          }),
        },
      }

    case "PullRequestAttention":
      return {
        data: {
          nodes: request.variables.ids.map((id) => {
            const pr = pullRequests.find((candidate) => candidate.id === id)

            return pr === undefined ? null : attentionNode(pr)
          }),
        },
      }

    case "SubscribedPullRequests":
      return {
        data: {
          nodes: request.variables.ids.map((id) => {
            const pr = pullRequests.find((candidate) => candidate.id === id)

            return pr === undefined ? null : subscribedNode(pr)
          }),
        },
      }

    case "QueuedPullRequests":
      return queuedPullRequests(
        request.variables,
        pullRequests,
        unavailableRepositories,
        timingOutRepositories,
      )

    case "EndedBranchPullRequests":
      return endedBranchPullRequests(request.variables, pullRequests)

    default:
      return absurd<never>(request)
  }
}
