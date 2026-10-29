import type { FakePullRequest } from "./fakePullRequest"

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
