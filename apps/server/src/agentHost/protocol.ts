import {
  Conversation,
  AgentCommand,
  AgentHarness,
  AgentEvent,
  AgentModels,
  ChangedFile,
  ExtensionStatusesChanged,
  MessageWithContext,
  ModelChoice,
  RequestAnswer,
  RequestNotWaiting,
} from "@glass/contracts"
import { Schema, SchemaTransformation } from "effect"
import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import { Rpc, RpcGroup } from "effect/rpc"
import { DeliveredMessage, DeliveredTurn } from "./deliveredMessage"

export const HostEvent = Schema.Union([...AgentEvent.members, ExtensionStatusesChanged])

export type HostEvent = typeof HostEvent.Type

export const JournalEntry = Schema.Struct({
  sequence: Schema.Int,
  conversationId: Schema.String,
  event: HostEvent,
})

export type JournalEntry = typeof JournalEntry.Type

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
    engine: AgentHarness,
    folder: HostFolder,
    role: RepositoryRole,
    skills: Schema.Array(SkillSource),
  }),
  Schema.Struct({
    conversationId: Schema.String,
    engine: Schema.Literal("pi"),
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

export const SteersNotTakenIn = Schema.Array(MessageWithContext)

export type SteersNotTakenIn = typeof SteersNotTakenIn.Type

export class AgentHostRpcs extends RpcGroup.make(
  Rpc.make("ListModels", {
    payload: { engine: AgentHarness },
    success: AgentModels,
    error: HostConversationError,
  }),
  Rpc.make("ListCommands", {
    payload: { engine: AgentHarness, folder: HostFolder, skills: Schema.Array(SkillSource) },
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
    payload: { conversationId: Schema.String },
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
  Rpc.make("HasUncommittedChanges", {
    payload: { folder: HostFolder },
    success: Schema.Boolean,
    error: HostConversationError,
  }),
  Rpc.make("WatchJournal", {
    payload: { after: Schema.Int },
    success: JournalEntry,
    stream: true,
  }),
  Rpc.make("Acknowledge", { payload: { through: Schema.Int } }),
) {}

export const couldNotSwitch = (harness: string, what: "model" | "effort" | "Permission mode") =>
  new HostConversationError({
    message: `${harness} couldn't switch to that ${what}. Pick another, then send your message again.`,
  })

export const notRunning = new HostConversationError({
  message: "The Conversation isn't working on a Turn.",
})
