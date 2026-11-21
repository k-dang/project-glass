import { Schema } from "effect"

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {}) {}

export const StorageGroup = Schema.Literals([
  "threads",
  "reviews",
  "activity",
  "toDos",
  "internals",
  "overhead",
])

export type StorageGroup = typeof StorageGroup.Type

export class StorageItem extends Schema.Class<StorageItem>("StorageItem")({
  name: Schema.String,
  group: StorageGroup,
  bytes: Schema.Int,
}) {}
