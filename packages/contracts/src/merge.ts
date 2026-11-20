import { Schema } from "effect"
import { ConnectionError } from "./connection"
import { StaleRevision } from "./revision"

export const MergeMethod = Schema.Literals(["squash", "merge", "rebase"])

export type MergeMethod = typeof MergeMethod.Type

export const Merge = Schema.TaggedStruct("Merge", { method: MergeMethod })

export const MergeWhenReady = Schema.TaggedStruct("MergeWhenReady", { method: MergeMethod })

export const AddToMergeQueue = Schema.TaggedStruct("AddToMergeQueue", {})

export const AddToMergeQueueWhenReady = Schema.TaggedStruct("AddToMergeQueueWhenReady", {})

export const MergeAction = Schema.Union([
  Merge,
  MergeWhenReady,
  AddToMergeQueue,
  AddToMergeQueueWhenReady,
])

export type MergeAction = typeof MergeAction.Type

export const MergeUnderWay = Schema.Literals(["auto-merge", "merge-queue"])

export type MergeUnderWay = typeof MergeUnderWay.Type

export class MergeRejected extends Schema.TaggedError<MergeRejected>()("MergeRejected", {
  message: Schema.String,
}) {}

export const MergePullRequestError = Schema.Union([StaleRevision, MergeRejected, ConnectionError])
