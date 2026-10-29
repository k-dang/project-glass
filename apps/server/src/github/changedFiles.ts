import {
  BinaryFile,
  ChangedFile,
  type ChangeType,
  EmptyFile,
  type FilePatch,
  NoTextChanges,
  PatchTooLarge,
  TextPatch,
} from "@glass/contracts"
import { Schema } from "effect"

const GitHubFileStatus = Schema.Literals([
  "added",
  "removed",
  "modified",
  "renamed",
  "copied",
  "changed",
  "unchanged",
])

export const GitHubChangedFile = Schema.Struct({
  sha: Schema.NullOr(Schema.String),
  filename: Schema.String,
  status: GitHubFileStatus,
  additions: Schema.Int,
  deletions: Schema.Int,
  patch: Schema.optional(Schema.String),
  previous_filename: Schema.optional(Schema.String),
})

export type GitHubChangedFile = typeof GitHubChangedFile.Type

const changeTypes: Record<typeof GitHubFileStatus.Type, ChangeType> = {
  added: "added",
  copied: "added",
  removed: "deleted",
  modified: "modified",
  changed: "modified",
  unchanged: "modified",
  renamed: "renamed",
}

const EMPTY_BLOB_SHA = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"

const unchangedContents = new Set<typeof GitHubFileStatus.Type>(["renamed", "changed", "unchanged"])

const filePatch = (file: GitHubChangedFile): FilePatch => {
  if (file.patch !== undefined) return TextPatch.make({ hunks: file.patch })

  if (file.additions + file.deletions > 0) return PatchTooLarge.make({})

  if (file.sha === EMPTY_BLOB_SHA) return EmptyFile.make({})

  if (unchangedContents.has(file.status)) return NoTextChanges.make({})

  return BinaryFile.make({})
}

export const toChangedFile = (file: GitHubChangedFile) =>
  new ChangedFile({
    path: file.filename,
    previousPath: file.status === "renamed" ? (file.previous_filename ?? null) : null,
    changeType: changeTypes[file.status],
    additions: file.additions,
    deletions: file.deletions,
    patch: filePatch(file),
  })
