import { Schema } from "effect"
import { ConnectionError } from "./connection"
import { StaleRevision } from "./revision"

export const MergeMethod = Schema.Literals(["squash", "merge", "rebase"])

export type MergeMethod = typeof MergeMethod.Type

export const CanMerge = Schema.TaggedStruct("CanMerge", {
  methods: Schema.NonEmptyArray(MergeMethod),
})

export const CanMergeWhenReady = Schema.TaggedStruct("CanMergeWhenReady", {
  methods: Schema.NonEmptyArray(MergeMethod),
})

export const CanAddToMergeQueue = Schema.TaggedStruct("CanAddToMergeQueue", {})

export const CanAddToMergeQueueWhenReady = Schema.TaggedStruct("CanAddToMergeQueueWhenReady", {})

export const MergeOffer = Schema.Union([
  CanMerge,
  CanMergeWhenReady,
  CanAddToMergeQueue,
  CanAddToMergeQueueWhenReady,
])

export type MergeOffer = typeof MergeOffer.Type

export const MergeUnderWay = Schema.Literals(["auto-merge", "merge-queue"])

export type MergeUnderWay = typeof MergeUnderWay.Type

export const Merge = Schema.TaggedStruct("Merge", { method: MergeMethod })

export const MergeWhenReady = Schema.TaggedStruct("MergeWhenReady", { method: MergeMethod })

export const AddToMergeQueue = Schema.TaggedStruct("AddToMergeQueue", {})

export const AddToMergeQueueWhenReady = Schema.TaggedStruct("AddToMergeQueueWhenReady", {})

export const MergeRequest = Schema.Union([
  Merge,
  MergeWhenReady,
  AddToMergeQueue,
  AddToMergeQueueWhenReady,
])

export type MergeRequest = typeof MergeRequest.Type

export class MergeRejected extends Schema.TaggedError<MergeRejected>()("MergeRejected", {
  message: Schema.String,
}) {}

export const MergePullRequestError = Schema.Union([StaleRevision, MergeRejected, ConnectionError])
