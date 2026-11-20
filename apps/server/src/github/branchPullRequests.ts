import {
  type FollowedRepository,
  PullRequestClosed,
  type PullRequestEnded,
  PullRequestMerged,
  PullRequestRef,
} from "@glass/contracts"
import { Schema } from "effect"
import { aliasedLookup } from "./aliasedLookups"

export interface Branch {
  readonly repository: FollowedRepository
  readonly branch: string
}

export interface EndedPullRequest {
  readonly ref: PullRequestRef
  readonly url: string
  readonly title: string
  readonly state: PullRequestEnded
}

const GitHubEndedPullRequest = Schema.Struct({
  number: Schema.Int,
  url: Schema.String,
  title: Schema.String,
  state: Schema.Literals(["CLOSED", "MERGED"]),
  isCrossRepository: Schema.Boolean,
})

export const EndedBranchPullRequests = aliasedLookup({
  name: "EndedBranchPullRequests",
  batchSize: 50,
  declarations: (index) =>
    `$owner${index}: String!, $name${index}: String!, $branch${index}: String!`,
  selection: (index) =>
    `repository(owner: $owner${index}, name: $name${index}) { pullRequests(headRefName: $branch${index}, states: [MERGED, CLOSED], first: 10, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...EndedPullRequest } } }`,
  fragment: `fragment EndedPullRequest on PullRequest {
  number url title state isCrossRepository
}`,
  variables: ({ repository, branch }: Branch, index) => [
    [`owner${index}`, repository.owner],
    [`name${index}`, repository.repo],
    [`branch${index}`, branch],
  ],
  answer: Schema.Struct({
    pullRequests: Schema.Struct({ nodes: Schema.Array(GitHubEndedPullRequest) }),
  }),
  decode: ({ pullRequests }, { repository }): EndedPullRequest | null => {
    const node = pullRequests.nodes.find((pr) => !pr.isCrossRepository)

    return node === undefined
      ? null
      : {
          ref: new PullRequestRef({
            owner: repository.owner,
            repo: repository.repo,
            number: node.number,
          }),
          url: node.url,
          title: node.title,
          state: node.state === "MERGED" ? PullRequestMerged.make({}) : PullRequestClosed.make({}),
        }
  },
})
