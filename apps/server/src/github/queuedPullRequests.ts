import {
  PullRequestRef,
  type PullRequestState,
  PullRequestSummary,
  Revision,
} from "@glass/contracts"
import { Result, Schema } from "effect"
import { login, GitHubAuthor } from "./author"
import { StatusState, toCheck } from "./repositoryPullRequests"

export const queuedPullRequestsQuery = (count: number) => {
  const indexes = Array.from({ length: count }, (_, index) => index)

  const variables = indexes
    .map((index) => `$owner${index}: String!, $name${index}: String!, $number${index}: Int!`)
    .join(", ")

  const lookups = indexes
    .map(
      (index) =>
        `pr${index}: repository(owner: $owner${index}, name: $name${index}) { pullRequest(number: $number${index}) { ...QueuedPullRequest } }`,
    )
    .join("\n  ")

  return `query QueuedPullRequests(${variables}) {
  ${lookups}
}

fragment QueuedPullRequest on PullRequest {
  id number url title author { login } updatedAt isDraft state baseRefOid headRefOid
  repository { owner { login } name }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`
}

export const queuedPullRequestsVariables = (refs: ReadonlyArray<PullRequestRef>) =>
  Object.fromEntries(
    refs.flatMap((ref, index) => [
      [`owner${index}`, ref.owner],
      [`name${index}`, ref.repo],
      [`number${index}`, ref.number],
    ]),
  )

const GitHubQueuedPullRequest = Schema.Struct({
  id: Schema.String,
  number: Schema.Int,
  url: Schema.String,
  title: Schema.String,
  author: GitHubAuthor,
  updatedAt: Schema.DateTimeUtcFromString,
  isDraft: Schema.Boolean,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  baseRefOid: Schema.String,
  headRefOid: Schema.String,
  repository: Schema.Struct({
    owner: Schema.Struct({ login: Schema.String }),
    name: Schema.String,
  }),
  commits: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        commit: Schema.Struct({
          statusCheckRollup: Schema.NullOr(Schema.Struct({ state: StatusState })),
        }),
      }),
    ),
  }),
})

export const QueuedPullRequestsResponse = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Record(
        Schema.String,
        Schema.NullOr(Schema.Struct({ pullRequest: Schema.NullOr(GitHubQueuedPullRequest) })),
      ),
    ),
  ),
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.optional(Schema.String),
        message: Schema.String,
        path: Schema.optional(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
      }),
    ),
  ),
})

export interface LookedUpPullRequest {
  readonly id: string
  readonly summary: PullRequestSummary
  readonly state: PullRequestState
  readonly revision: Revision
}

const states = { OPEN: "open", CLOSED: "closed", MERGED: "merged" } as const

const toLookedUp = (node: typeof GitHubQueuedPullRequest.Type): LookedUpPullRequest => ({
  id: node.id,
  summary: new PullRequestSummary({
    ref: new PullRequestRef({
      owner: node.repository.owner.login,
      repo: node.repository.name,
      number: node.number,
    }),
    url: node.url,
    title: node.title,
    author: login(node.author),
    isDraft: node.isDraft,
    checks: toCheck(node.commits.nodes[0]?.commit.statusCheckRollup),
    updatedAt: node.updatedAt,
  }),
  state: node.state === "OPEN" && node.isDraft ? "draft" : states[node.state],
  revision: new Revision({ base: node.baseRefOid, head: node.headRefOid }),
})

const missingTypes = new Set(["NOT_FOUND", "FORBIDDEN"])

export const toLookedUpBatch = (
  count: number,
  { data, errors }: typeof QueuedPullRequestsResponse.Type,
): Result.Result<ReadonlyArray<LookedUpPullRequest | null>, string> => {
  const aliases = Array.from({ length: count }, (_, index) => `pr${index}`)

  const unanswered = errors?.find(
    (error) => !aliases.includes(String(error.path?.[0])) || !missingTypes.has(error.type ?? ""),
  )

  if (unanswered !== undefined) return Result.fail(unanswered.message)

  if (data == null) return Result.fail("GraphQL QueuedPullRequests answered without data")

  return Result.succeed(
    aliases.map((alias) => {
      const node = data[alias]?.pullRequest

      return node == null ? null : toLookedUp(node)
    }),
  )
}
