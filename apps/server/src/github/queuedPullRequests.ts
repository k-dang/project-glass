import {
  PullRequestRef,
  type PullRequestState,
  PullRequestSummary,
  Revision,
} from "@glass/contracts"
import { type DateTime, Schema } from "effect"
import { login, GitHubAuthor } from "./author"
import { aliasedLookup } from "./aliasedLookups"
import { checksOfRollup, StatusState } from "./checkContexts"
import { GitHubPullRequestState } from "./repositoryPullRequests"

const GitHubQueuedPullRequest = Schema.Struct({
  id: Schema.String,
  number: Schema.Int,
  url: Schema.String,
  title: Schema.String,
  author: GitHubAuthor,
  updatedAt: Schema.DateTimeUtcFromString,
  isDraft: Schema.Boolean,
  state: GitHubPullRequestState,
  baseRefOid: Schema.String,
  headRefOid: Schema.String,
  mergedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  closedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
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

export interface LookedUpPullRequest {
  readonly id: string
  readonly summary: PullRequestSummary
  readonly state: PullRequestState
  readonly revision: Revision
  readonly mergedAt: DateTime.Utc | null
  readonly closedAt: DateTime.Utc | null
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
    checks: checksOfRollup(node.commits.nodes[0]?.commit.statusCheckRollup),
    updatedAt: node.updatedAt,
  }),
  state: node.state === "OPEN" && node.isDraft ? "draft" : states[node.state],
  revision: new Revision({ base: node.baseRefOid, head: node.headRefOid }),
  mergedAt: node.mergedAt,
  closedAt: node.closedAt,
})

export const QueuedPullRequests = aliasedLookup({
  name: "QueuedPullRequests",
  batchSize: 50,
  declarations: (index) => `$owner${index}: String!, $name${index}: String!, $number${index}: Int!`,
  selection: (index) =>
    `repository(owner: $owner${index}, name: $name${index}) { pullRequest(number: $number${index}) { ...QueuedPullRequest } }`,
  fragment: `fragment QueuedPullRequest on PullRequest {
  id number url title author { login } updatedAt isDraft state baseRefOid headRefOid mergedAt closedAt
  repository { owner { login } name }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`,
  variables: (ref: PullRequestRef, index) => [
    [`owner${index}`, ref.owner],
    [`name${index}`, ref.repo],
    [`number${index}`, ref.number],
  ],
  answer: Schema.Struct({ pullRequest: Schema.NullOr(GitHubQueuedPullRequest) }),
  decode: ({ pullRequest }) => (pullRequest === null ? null : toLookedUp(pullRequest)),
})
