import {
  Agent,
  AgentCommand,
  AgentEngine,
  AgentEvent,
  AgentModels,
  ChangedFile,
  MessageWithContext,
  ModelChoice,
  RequestAnswer,
  RequestNotWaiting,
} from "@glass/contracts"
import { Schema, SchemaTransformation } from "effect"
import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import { Rpc, RpcGroup } from "effect/rpc"
import { DeliveredMessage } from "./deliveredMessage"

export const JournalEntry = Schema.Struct({
  sequence: Schema.Int,
  agentId: Schema.String,
  event: AgentEvent,
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
  permissionMode: Agent.fields.permissionMode,
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

export const SkillSource = Schema.Struct({ name: Schema.String, files: Schema.Array(SkillFile) })

export type SkillSource = typeof SkillSource.Type

export const WorkRole = Schema.TaggedStruct("Work", { skills: Schema.Array(SkillSource) })

export const ReviewRole = Schema.TaggedStruct("Review", { brief: ReviewBrief })

/** Where a conversation's runtime reaches Glass's tools, and the credential it calls them with. */
export const GlassToolsAccess = Schema.Struct({
  url: Schema.String,
  bearer: Schema.RedactedFromValue(Schema.String),
})

export type GlassToolsAccess = typeof GlassToolsAccess.Type

export const GlobalRole = Schema.TaggedStruct("Global", { tools: GlassToolsAccess })

export const AgentRole = Schema.Union([WorkRole, ReviewRole])

export type AgentRole = typeof AgentRole.Type

export type ConversationRole = AgentRole | typeof GlobalRole.Type

/** An Agent runs in either Agent program; the Global conversation runs only in pi. */
export const ConversationStart = Schema.Union([
  Schema.Struct({
    agentId: Schema.String,
    engine: AgentEngine,
    folder: HostFolder,
    role: AgentRole,
  }),
  Schema.Struct({
    agentId: Schema.String,
    engine: Schema.Literal("pi"),
    folder: HostFolder,
    role: GlobalRole,
  }),
])

export type ConversationStart = typeof ConversationStart.Type

export class HostAgentError extends Schema.TaggedError<HostAgentError>()("HostAgentError", {
  message: Schema.String,
}) {}

export const SteersNotTakenIn = Schema.Array(MessageWithContext)

export type SteersNotTakenIn = typeof SteersNotTakenIn.Type

export class AgentHostRpcs extends RpcGroup.make(
  Rpc.make("ListModels", {
    payload: { engine: AgentEngine },
    success: AgentModels,
    error: HostAgentError,
  }),
  Rpc.make("ListCommands", {
    payload: { engine: AgentEngine, folder: HostFolder, skills: Schema.Array(SkillSource) },
    success: Schema.Array(AgentCommand),
    error: HostAgentError,
  }),
  Rpc.make("StartAgent", {
    payload: ConversationStart,
    /** Whether it started the program, rather than finding it already running. */
    success: Schema.Boolean,
    error: HostAgentError,
  }),
  Rpc.make("StartTurn", {
    payload: {
      agentId: Schema.String,
      turnId: Schema.String,
      ...DeliveredMessage.fields,
      ...TurnSettings.fields,
    },
    error: HostAgentError,
  }),
  Rpc.make("AnswerRequest", {
    payload: { agentId: Schema.String, requestId: Schema.String, answer: RequestAnswer },
    error: Schema.Union([RequestNotWaiting, HostAgentError]),
  }),
  Rpc.make("Steer", {
    payload: { agentId: Schema.String, ...DeliveredMessage.fields },
    error: HostAgentError,
  }),
  Rpc.make("StopTurn", {
    payload: { agentId: Schema.String },
    success: Schema.NullOr(SteersNotTakenIn),
  }),
  Rpc.make("StopAgent", { payload: { agentId: Schema.String } }),
  Rpc.make("GetChanges", {
    payload: { folder: HostFolder, baseRef: Schema.String },
    success: Schema.Array(ChangedFile),
    error: HostAgentError,
  }),
  Rpc.make("ListFiles", {
    payload: { folder: HostFolder },
    success: Schema.Array(Schema.String),
    error: HostAgentError,
  }),
  Rpc.make("HasUncommittedChanges", {
    payload: { folder: HostFolder },
    success: Schema.Boolean,
    error: HostAgentError,
  }),
  Rpc.make("WatchJournal", {
    payload: { after: Schema.Int },
    success: JournalEntry,
    stream: true,
  }),
  Rpc.make("Acknowledge", { payload: { through: Schema.Int } }),
) {}

export const couldNotSwitch = (program: string, what: "model" | "effort" | "Permission mode") =>
  new HostAgentError({
    message: `${program} couldn't switch to that ${what}. Pick another, then send your message again.`,
  })

export const notRunning = new HostAgentError({ message: "The Agent isn't working on a Turn." })
