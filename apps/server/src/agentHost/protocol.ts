import {
  Thread,
  AgentCommand,
  AgentHarness,
  AgentModels,
  ChangedFile,
  ThreadFile,
  AgentStatusesChanged,
  MessageWithContext,
  ModelChoice,
  NamedPaths,
  PartAppended,
  PartSet,
  RequestAnswer,
  RequestNotWaiting,
  ToolCallStatusSet,
  TurnEnded,
  TurnStarted,
} from "@glass/contracts"
import { Effect, Schema, SchemaTransformation } from "effect"
import { McpSchema } from "effect/ai"
import type { ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import { Readable } from "node:stream"
import { text } from "node:stream/consumers"
import { Rpc, RpcGroup } from "effect/rpc"
import { DeliveredMessage, DeliveredTurn } from "./deliveredMessage"

export const SteersNotTakenIn = Schema.Array(MessageWithContext)

export type SteersNotTakenIn = typeof SteersNotTakenIn.Type

const HostTurnEnded = Schema.TaggedStruct("TurnEnded", {
  ...TurnEnded.fields,
  steersNotTakenIn: Schema.optional(SteersNotTakenIn),
})

export const HostEvent = Schema.Union([
  TurnStarted,
  PartSet,
  PartAppended,
  ToolCallStatusSet,
  HostTurnEnded,
  AgentStatusesChanged,
])

export type HostEvent = typeof HostEvent.Type

export const JournalEntry = Schema.Struct({
  sequence: Schema.Int,
  threadId: Schema.String,
  event: HostEvent,
})

export type JournalEntry = typeof JournalEntry.Type

// WARNING: Raise HOST_PROTOCOL when an AgentHostRpcs change breaks talking to a previous host; Sandboxes keep hosts running across upgrades.
export const HOST_PROTOCOL = 3

// WARNING: Glass asks hosts of every version for Hello, so its shape must never change.
export const Hello = Rpc.make("Hello", {
  success: Schema.Struct({ host: Schema.String, protocol: Schema.Int }),
})

export class HostReplaced extends Schema.TaggedError<HostReplaced>()("HostReplaced", {}) {}

export const newHostToken = () => randomBytes(32).toString("base64url")

const HostFolder = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (folder) => resolve(folder),
      encode: (folder) => folder,
    }),
  ),
)

export const HostReady = Schema.fromJsonString(Schema.Struct({ port: Schema.Int }))

export const hostPort = async (host: ChildProcess) => {
  const ready = host.stdio[3]

  if (!(ready instanceof Readable)) throw new Error("The host has no readiness pipe")

  return Schema.decodeUnknownSync(HostReady)(await text(ready)).port
}

export const UnacknowledgedTurn = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
})

export type UnacknowledgedTurn = typeof UnacknowledgedTurn.Type

export const TurnSettings = Schema.Struct({
  ...ModelChoice.fields,
  permissionMode: Thread.fields.permissionMode,
})

export type TurnSettings = typeof TurnSettings.Type

const LinesByPath = Schema.Record(Schema.String, Schema.Array(Schema.Int))

export const ReviewBrief = Schema.Struct({
  instructions: Schema.String,
  diffLines: Schema.Struct({ old: LinesByPath, new: LinesByPath }),
})

export type ReviewBrief = typeof ReviewBrief.Type

const SkillFile = Schema.Struct({
  path: Schema.String,
  executable: Schema.Boolean,
  contents: Schema.Uint8Array,
})

type SkillFile = typeof SkillFile.Type

export const SentSkill = Schema.Struct({ name: Schema.String, files: Schema.Array(SkillFile) })

export type SentSkill = typeof SentSkill.Type

export const SkillSource = Schema.Struct({ name: Schema.String, skills: Schema.Array(SentSkill) })

export type SkillSource = typeof SkillSource.Type

export const GlassToolsAccess = Schema.Struct({
  url: Schema.String,
  bearer: Schema.RedactedFromValue(Schema.String),
})

export type GlassToolsAccess = typeof GlassToolsAccess.Type

export const WorkRole = Schema.TaggedStruct("Work", {})

export const ReviewRole = Schema.TaggedStruct("Review", { brief: ReviewBrief })

export const GlobalRole = Schema.TaggedStruct("Global", { tools: GlassToolsAccess })

export const RepositoryRole = Schema.Union([WorkRole, ReviewRole])

export type RepositoryRole = typeof RepositoryRole.Type

export type ThreadRole = RepositoryRole | typeof GlobalRole.Type

export const StartOutcome = Schema.Literals(["started", "alreadyRunning"])

export type StartOutcome = typeof StartOutcome.Type

export const ThreadStart = Schema.Union([
  Schema.Struct({
    threadId: Schema.String,
    harness: AgentHarness,
    folder: HostFolder,
    role: RepositoryRole,
    skills: Schema.Array(SkillSource),
  }),
  Schema.Struct({
    threadId: Schema.String,
    harness: Schema.Literal("pi"),
    folder: HostFolder,
    role: GlobalRole,
    skills: Schema.Array(SkillSource),
  }),
])

export type ThreadStart = typeof ThreadStart.Type

export const RelayedToolCall = Schema.Struct({
  callId: Schema.String,
  threadId: Schema.String,
  name: Schema.String,
  arguments: Schema.JsonObject,
})

export type RelayedToolCall = typeof RelayedToolCall.Type

export const failedToolCall = (reason: string) =>
  new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text: reason }] })

export class HostThreadError extends Schema.TaggedError<HostThreadError>()("HostThreadError", {
  message: Schema.String,
}) {}

export class AgentHostRpcs extends RpcGroup.make(
  Hello,
  Rpc.make("ListModels", {
    payload: { harness: AgentHarness },
    success: AgentModels,
    error: HostThreadError,
  }),
  Rpc.make("ListCommands", {
    payload: { harness: AgentHarness, folder: HostFolder, skills: Schema.Array(SkillSource) },
    success: Schema.Array(AgentCommand),
    error: HostThreadError,
  }),
  Rpc.make("StartThread", {
    payload: ThreadStart,
    success: StartOutcome,
    error: HostThreadError,
  }),
  Rpc.make("StartTurn", {
    payload: {
      threadId: Schema.String,
      turnId: Schema.String,
      ...DeliveredTurn.fields,
      ...TurnSettings.fields,
    },
    error: HostThreadError,
  }),
  Rpc.make("AnswerRequest", {
    payload: { threadId: Schema.String, requestId: Schema.String, answer: RequestAnswer },
    error: Schema.Union([RequestNotWaiting, HostThreadError]),
  }),
  Rpc.make("Steer", {
    payload: { threadId: Schema.String, ...DeliveredMessage.fields },
    error: HostThreadError,
  }),
  Rpc.make("StopTurn", {
    payload: { threadId: Schema.String, turnId: Schema.String },
    success: Schema.NullOr(SteersNotTakenIn),
  }),
  Rpc.make("StopThread", { payload: { threadId: Schema.String } }),
  Rpc.make("GetChanges", {
    payload: { folder: HostFolder, baseRef: Schema.String },
    success: Schema.Array(ChangedFile),
    error: HostThreadError,
  }),
  Rpc.make("ListFiles", {
    payload: { folder: HostFolder },
    success: Schema.Array(Schema.String),
    error: HostThreadError,
  }),
  Rpc.make("ExistingFiles", {
    payload: { folder: HostFolder, paths: NamedPaths },
    success: Schema.Array(Schema.String),
    error: HostThreadError,
  }),
  Rpc.make("ReadFile", {
    payload: { folder: HostFolder, path: Schema.String },
    success: ThreadFile,
    error: HostThreadError,
  }),
  Rpc.make("HasUncommittedChanges", {
    payload: { folder: HostFolder },
    success: Schema.Boolean,
    error: HostThreadError,
  }),
  Rpc.make("CurrentBranch", {
    payload: { folder: HostFolder },
    success: Schema.NullOr(Schema.String),
    error: HostThreadError,
  }),
  Rpc.make("WatchJournal", {
    payload: { host: Schema.String, after: Schema.Int },
    success: JournalEntry,
    error: HostReplaced,
    stream: true,
  }),
  Rpc.make("Acknowledge", { payload: { host: Schema.String, through: Schema.Int } }),
  Rpc.make("UnacknowledgedTurns", {
    success: Schema.Array(UnacknowledgedTurn),
  }),
  Rpc.make("OfferGlassTools", {
    payload: { host: Schema.String, tools: Schema.Array(McpSchema.Tool) },
    error: HostReplaced,
  }),
  Rpc.make("WatchToolCalls", {
    payload: { host: Schema.String },
    success: RelayedToolCall,
    error: HostReplaced,
    stream: true,
  }),
  Rpc.make("AnswerToolCall", {
    payload: { host: Schema.String, callId: Schema.String, result: McpSchema.CallToolResult },
  }),
) {}

export const couldNotSwitch = (harness: string, what: "model" | "effort" | "Permission mode") =>
  new HostThreadError({
    message: `${harness} couldn't switch to that ${what}. Pick another, then send your message again.`,
  })

export const notRunning = new HostThreadError({
  message: "The Thread isn't working on a Turn.",
})

export const failure =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError((cause) => Effect.logWarning(message, cause)),
      Effect.mapError(() => new HostThreadError({ message })),
    )
