import type { FakeCheck, FakePullRequest, FakeReview } from "./fakePullRequest"

export const PAGE_SIZE = 100

export const connectionPage = <A>(nodes: ReadonlyArray<A>, after: string | null) => {
  const offset = after === null ? 0 : Number(after)
  const end = offset + PAGE_SIZE

  return {
    pageInfo: { hasNextPage: end < nodes.length, endCursor: String(end) },
    nodes: nodes.slice(offset, end),
  }
}

export const avatarUrl = (login: string) => `https://avatars.githubusercontent.com/${login}`

export const author = (login: string | null) =>
  login === null ? null : { login, avatarUrl: avatarUrl(login) }

export const inRepo = (owner: string, repo: string) => (pr: FakePullRequest) =>
  pr.owner.toLowerCase() === owner.toLowerCase() && pr.repo.toLowerCase() === repo.toLowerCase()

export const reviewRequestNodes = (pr: FakePullRequest) => [
  ...[...pr.requestedReviewers].map((login) => ({
    requestedReviewer: { __typename: "User", login },
  })),
  ...[...pr.requestedTeams].map((team) => {
    const [owner, slug] = team.split("/")

    return { requestedReviewer: { __typename: "Team", slug, organization: { login: owner } } }
  }),
]

export const latestOpinionatedReviews = (pr: FakePullRequest) => {
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

/** The head commit's checks, as `CHECK_CONTEXTS_FIELDS` asks for them. */
export const checkContextsNode = (pr: FakePullRequest) => ({
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
})
