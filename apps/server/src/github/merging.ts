import {
  CanAddToMergeQueue,
  CanAddToMergeQueueWhenReady,
  CanMerge,
  CanMergeWhenReady,
  MergeMethod,
  type MergeOffer,
  type MergeRequest,
  type MergeUnderWay,
} from "@glass/contracts"
import { Array as Arr, Match, Schema } from "effect"
import type { GitHubPullRequestState } from "./queries"

export const MERGING_FIELDS = `mergeStateStatus
      isMergeQueueEnabled
      isInMergeQueue
      autoMergeRequest { __typename }
      viewerCanEnableAutoMerge`

export const MERGING_REPOSITORY_FIELDS = `viewerPermission
        viewerDefaultMergeMethod
        squashMergeAllowed
        mergeCommitAllowed
        rebaseMergeAllowed`

const GitHubMergeMethod = Schema.Literals(["SQUASH", "MERGE", "REBASE"])

export const MergingFields = {
  mergeStateStatus: Schema.Literals([
    "CLEAN",
    "HAS_HOOKS",
    "UNSTABLE",
    "BLOCKED",
    "BEHIND",
    "DIRTY",
    "UNKNOWN",
  ]),
  isMergeQueueEnabled: Schema.Boolean,
  isInMergeQueue: Schema.Boolean,
  autoMergeRequest: Schema.NullOr(Schema.Struct({})),
  viewerCanEnableAutoMerge: Schema.Boolean,
}

export const MergingRepositoryFields = {
  viewerPermission: Schema.NullOr(
    Schema.Literals(["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"]),
  ),
  viewerDefaultMergeMethod: GitHubMergeMethod,
  squashMergeAllowed: Schema.Boolean,
  mergeCommitAllowed: Schema.Boolean,
  rebaseMergeAllowed: Schema.Boolean,
}

type GitHubMerging = Schema.Struct.Type<typeof MergingFields> & {
  readonly state: typeof GitHubPullRequestState.Type
  readonly isDraft: boolean
  readonly repository: Schema.Struct.Type<typeof MergingRepositoryFields>
}

const methods: Record<typeof GitHubMergeMethod.Type, MergeMethod> = {
  SQUASH: "squash",
  MERGE: "merge",
  REBASE: "rebase",
}

const gitHubMethods: Record<MergeMethod, typeof GitHubMergeMethod.Type> = {
  squash: "SQUASH",
  merge: "MERGE",
  rebase: "REBASE",
}

const allowedMethods = (repository: GitHubMerging["repository"]) => {
  const allowed: Record<MergeMethod, boolean> = {
    squash: repository.squashMergeAllowed,
    merge: repository.mergeCommitAllowed,
    rebase: repository.rebaseMergeAllowed,
  }

  const preferred = methods[repository.viewerDefaultMergeMethod]

  return [preferred, ...MergeMethod.literals.filter((method) => method !== preferred)].filter(
    (method) => allowed[method],
  )
}

const canMerge: Record<NonNullable<GitHubMerging["repository"]["viewerPermission"]>, boolean> = {
  ADMIN: true,
  MAINTAIN: true,
  WRITE: true,
  TRIAGE: false,
  READ: false,
}

const readiness: Record<GitHubMerging["mergeStateStatus"], "now" | "when-ready" | null> = {
  CLEAN: "now",
  HAS_HOOKS: "now",
  UNSTABLE: "now",
  BLOCKED: "when-ready",
  BEHIND: "when-ready",
  DIRTY: null,
  UNKNOWN: null,
}

const offerFor = (pr: GitHubMerging): MergeOffer | null => {
  const ready = readiness[pr.mergeStateStatus]

  if (ready === null || (ready === "when-ready" && !pr.viewerCanEnableAutoMerge)) return null

  if (pr.isMergeQueueEnabled) {
    return ready === "now" ? CanAddToMergeQueue.make({}) : CanAddToMergeQueueWhenReady.make({})
  }

  const allowed = allowedMethods(pr.repository)

  if (!Arr.isReadonlyArrayNonEmpty(allowed)) return null

  return ready === "now"
    ? CanMerge.make({ methods: allowed })
    : CanMergeWhenReady.make({ methods: allowed })
}

interface Merging {
  readonly mergeOffer: MergeOffer | null
  readonly mergeUnderWay: MergeUnderWay | null
}

export const toMerging = (pr: GitHubMerging): Merging => {
  const permission = pr.repository.viewerPermission

  if (pr.state !== "OPEN" || pr.isDraft || permission === null || !canMerge[permission]) {
    return { mergeOffer: null, mergeUnderWay: null }
  }

  if (pr.isInMergeQueue) return { mergeOffer: null, mergeUnderWay: "merge-queue" }

  if (pr.autoMergeRequest !== null) return { mergeOffer: null, mergeUnderWay: "auto-merge" }

  return { mergeOffer: offerFor(pr), mergeUnderWay: null }
}

const MERGE_MUTATION = `mutation MergePullRequest($pullRequestId: ID!, $expectedHeadOid: GitObjectID!, $mergeMethod: PullRequestMergeMethod!) {
  mergePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid, mergeMethod: $mergeMethod }) { clientMutationId }
}`

const AUTO_MERGE_MUTATION = `mutation EnablePullRequestAutoMerge($pullRequestId: ID!, $expectedHeadOid: GitObjectID!, $mergeMethod: PullRequestMergeMethod) {
  enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid, mergeMethod: $mergeMethod }) { clientMutationId }
}`

const ENQUEUE_MUTATION = `mutation EnqueuePullRequest($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
  enqueuePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid }) { clientMutationId }
}`

export const mergeOperation = (pullRequestId: string, head: string, request: MergeRequest) => {
  const target = { pullRequestId, expectedHeadOid: head }

  return Match.value(request).pipe(
    Match.tagsExhaustive({
      Merge: ({ method }) => ({
        name: "MergePullRequest",
        query: MERGE_MUTATION,
        variables: { ...target, mergeMethod: gitHubMethods[method] },
      }),
      MergeWhenReady: ({ method }) => ({
        name: "EnablePullRequestAutoMerge",
        query: AUTO_MERGE_MUTATION,
        variables: { ...target, mergeMethod: gitHubMethods[method] },
      }),
      AddToMergeQueue: () => ({
        name: "EnqueuePullRequest",
        query: ENQUEUE_MUTATION,
        variables: target,
      }),
      AddToMergeQueueWhenReady: () => ({
        name: "EnablePullRequestAutoMerge",
        query: AUTO_MERGE_MUTATION,
        variables: { ...target, mergeMethod: null },
      }),
    }),
  )
}

// WARNING: GitHub reports a moved head only in its message text, as "Head branch was modified".
export const HEAD_MOVED = /head branch was modified/i
