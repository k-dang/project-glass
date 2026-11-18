import {
  Conversation,
  AgentCommand,
  AgentHarness,
  AgentModels,
  ChangedFile,
  ConversationFile,
  AgentStatusesChanged,
  MessageWithContext,
  ModelChoice,
  NamedPaths,
  PartAppended,
  PartSet,
  RequestAnswer,
  RequestNotWaiting,
  TurnEnded,
  TurnStarted,
} from "@glass/contracts"
import { Effect, Schema, SchemaTransformation } from "effect"
import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import { Rpc, RpcGroup } from "effect/rpc"
import { DeliveredMessage, DeliveredTurn } from "./deliveredMessage"

export const SteersNotTakenIn = Schema.Array(MessageWithContext)

export type SteersNotTakenIn = typeof SteersNotTakenIn.Type

// A Turn the host stopped on its own has no StopTurn reply to give its Steers back on.
export const HostTurnEnded = Schema.TaggedStruct("TurnEnded", {
  ...TurnEnded.fields,
  steersNotTakenIn: Schema.optional(SteersNotTakenIn),
})

export const HostEvent = Schema.Union([
  TurnStarted,
  PartSet,
  PartAppended,
  HostTurnEnded,
  AgentStatusesChanged,
])

export type HostEvent = typeof HostEvent.Type

export const JournalEntry = Schema.Struct({
  sequence: Schema.Int,
  conversationId: Schema.String,
  event: HostEvent,
})

export type JournalEntry = typeof JournalEntry.Type

// Raise this when a change to AgentHostRpcs would break talking to a host of the previous
// version, which a Sandbox keeps running across Glass upgrades.
export const HOST_PROTOCOL = 1

// Glass asks hosts of any version for this, so its shape must never change.
export const Hello = Rpc.make("Hello", {
  success: Schema.Struct({ host: Schema.String, protocol: Schema.Int }),
})

export class HostReplaced extends Schema.TaggedError<HostReplaced>()("HostReplaced", {}) {}

export const HOST_TOKEN_HEADER = "x-glass-host-token"

export const newHostToken = () => randomBytes(32).toString("base64url")

export const HEALTH_PATH = "/healthz"

export const SHUTDOWN_PATH = "/shutdown"

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

export const TurnSettings = Schema.Struct({
  ...ModelChoice.fields,
  permissionMode: Conversation.fields.permissionMode,
})

export type TurnSettings = typeof TurnSettings.Type

const LinesByPath = Schema.Record(Schema.String, Schema.Array(Schema.Int))

export const ReviewBrief = Schema.Struct({
  instructions: Schema.String,
  diffLines: Schema.Struct({ old: LinesByPath, new: LinesByPath }),
})

export type ReviewBrief = typeof ReviewBrief.Type

export const SkillFile = Schema.Struct({
  path: Schema.String,
  executable: Schema.Boolean,
  contents: Schema.Uint8Array,
})

export type SkillFile = typeof SkillFile.Type

export const SentSkill = Schema.Struct({ name: Schema.String, files: Schema.Array(SkillFile) })

export type SentSkill = typeof SentSkill.Type

export const SkillSource = Schema.Struct({ name: Schema.String, skills: Schema.Array(SentSkill) })

export type SkillSource = typeof SkillSource.Type

export const WorkRole = Schema.TaggedStruct("Work", {})

export const ReviewRole = Schema.TaggedStruct("Review", { brief: ReviewBrief })

export const GlassToolsAccess = Schema.Struct({
  url: Schema.String,
  bearer: Schema.RedactedFromValue(Schema.String),
})

export type GlassToolsAccess = typeof GlassToolsAccess.Type

export const GlobalRole = Schema.TaggedStruct("Global", { tools: GlassToolsAccess })

export const RepositoryRole = Schema.Union([WorkRole, ReviewRole])

export type RepositoryRole = typeof RepositoryRole.Type

export type ConversationRole = RepositoryRole | typeof GlobalRole.Type

export const StartOutcome = Schema.Literals(["started", "alreadyRunning"])

export type StartOutcome = typeof StartOutcome.Type

export const ConversationStart = Schema.Union([
  Schema.Struct({
    conversationId: Schema.String,
    harness: AgentHarness,
    folder: HostFolder,
    role: RepositoryRole,
    skills: Schema.Array(SkillSource),
  }),
  Schema.Struct({
    conversationId: Schema.String,
    harness: Schema.Literal("pi"),
    folder: HostFolder,
    role: GlobalRole,
    skills: Schema.Array(SkillSource),
  }),
])

export type ConversationStart = typeof ConversationStart.Type

export class HostConversationError extends Schema.TaggedError<HostConversationError>()(
  "HostConversationError",
  {
    message: Schema.String,
  },
) {}

export class AgentHostRpcs extends RpcGroup.make(
  Hello,
  Rpc.make("ListModels", {
    payload: { harness: AgentHarness },
    success: AgentModels,
    error: HostConversationError,
  }),
  Rpc.make("ListCommands", {
    payload: { harness: AgentHarness, folder: HostFolder, skills: Schema.Array(SkillSource) },
    success: Schema.Array(AgentCommand),
    error: HostConversationError,
  }),
  Rpc.make("StartConversation", {
    payload: ConversationStart,
    success: StartOutcome,
    error: HostConversationError,
  }),
  Rpc.make("StartTurn", {
    payload: {
      conversationId: Schema.String,
      turnId: Schema.String,
      ...DeliveredTurn.fields,
      ...TurnSettings.fields,
    },
    error: HostConversationError,
  }),
  Rpc.make("AnswerRequest", {
    payload: { conversationId: Schema.String, requestId: Schema.String, answer: RequestAnswer },
    error: Schema.Union([RequestNotWaiting, HostConversationError]),
  }),
  Rpc.make("Steer", {
    payload: { conversationId: Schema.String, ...DeliveredMessage.fields },
    error: HostConversationError,
  }),
  Rpc.make("StopTurn", {
    payload: { conversationId: Schema.String, turnId: Schema.String },
    success: Schema.NullOr(SteersNotTakenIn),
  }),
  Rpc.make("StopConversation", { payload: { conversationId: Schema.String } }),
  Rpc.make("GetChanges", {
    payload: { folder: HostFolder, baseRef: Schema.String },
    success: Schema.Array(ChangedFile),
    error: HostConversationError,
  }),
  Rpc.make("ListFiles", {
    payload: { folder: HostFolder },
    success: Schema.Array(Schema.String),
    error: HostConversationError,
  }),
  Rpc.make("ExistingFiles", {
    payload: { folder: HostFolder, paths: NamedPaths },
    success: Schema.Array(Schema.String),
    error: HostConversationError,
  }),
  Rpc.make("ReadFile", {
    payload: { folder: HostFolder, path: Schema.String },
    success: ConversationFile,
    error: HostConversationError,
  }),
  Rpc.make("HasUncommittedChanges", {
    payload: { folder: HostFolder },
    success: Schema.Boolean,
    error: HostConversationError,
  }),
  Rpc.make("WatchJournal", {
    payload: { host: Schema.String, after: Schema.Int },
    success: JournalEntry,
    error: HostReplaced,
    stream: true,
  }),
  Rpc.make("Acknowledge", { payload: { host: Schema.String, through: Schema.Int } }),
) {}

export const couldNotSwitch = (harness: string, what: "model" | "effort" | "Permission mode") =>
  new HostConversationError({
    message: `${harness} couldn't switch to that ${what}. Pick another, then send your message again.`,
  })

export const notRunning = new HostConversationError({
  message: "The Conversation isn't working on a Turn.",
})

export const failure =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError((cause) => Effect.logWarning(message, cause)),
      Effect.mapError(() => new HostConversationError({ message })),
    )
