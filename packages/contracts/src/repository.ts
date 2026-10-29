import { Schema } from "effect"
import { ConnectionError } from "./connection"
import { BinaryFile, PullRequestNotFound } from "./pullRequest"
import { RevisionSide } from "./revision"

export const TextFile = Schema.TaggedStruct("TextFile", { text: Schema.String })

export const FileTooLarge = Schema.TaggedStruct("FileTooLarge", {})

export const FileContents = Schema.Union([TextFile, BinaryFile, FileTooLarge])

export type FileContents = typeof FileContents.Type

export class RepositoryFiles extends Schema.Class<RepositoryFiles>("RepositoryFiles")({
  paths: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
}) {}

export class FileNotFound extends Schema.TaggedError<FileNotFound>()("FileNotFound", {
  path: Schema.String,
  side: RevisionSide,
}) {}

export const GetFileContentsError = Schema.Union([
  FileNotFound,
  PullRequestNotFound,
  ConnectionError,
])
