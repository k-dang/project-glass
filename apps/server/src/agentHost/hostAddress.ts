import { Effect, type FileSystem, Schema } from "effect"
import { join } from "node:path"

export const HOST_TOKEN_HEADER = "x-glass-host-token"

export const HEALTH_PATH = "/healthz"

export const SHUTDOWN_PATH = "/shutdown"

export const hostRecordPath = (dataDirectory: string) => join(dataDirectory, "agent-host.json")

export const RecordedHost = Schema.fromJsonString(
  Schema.Struct({ port: Schema.Int, token: Schema.String, fingerprint: Schema.String }),
)

export type RecordedHost = typeof RecordedHost.Type

export const readHostRecord = (fs: FileSystem.FileSystem, path: string) =>
  fs.readFileString(path).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RecordedHost)))
