import {
  Agent,
  AgentCommand,
  AgentEngine,
  AgentEvent,
  AgentModels,
  ChangedFile,
  ModelChoice,
  RequestAnswer,
  RequestNotWaiting,
  SentMessage,
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

/** A `POST` here ends the host, and with it every agent program. */
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

export class HostAgentError extends Schema.TaggedError<HostAgentError>()("HostAgentError", {
  message: Schema.String,
}) {}

export class AgentHostRpcs extends RpcGroup.make(
  Rpc.make("ListModels", {
    payload: { engine: AgentEngine },
    success: AgentModels,
    error: HostAgentError,
  }),
  Rpc.make("ListCommands", {
    payload: { engine: AgentEngine, folder: HostFolder },
    success: Schema.Array(AgentCommand),
    error: HostAgentError,
  }),
  Rpc.make("StartAgent", {
    payload: {
      agentId: Schema.String,
      engine: AgentEngine,
      folder: HostFolder,
      review: Schema.NullOr(ReviewBrief),
    },
    error: HostAgentError,
  }),
  /** Starts a Turn the backend has recorded; its parts and ending arrive through WatchJournal. */
  Rpc.make("StartTurn", {
    payload: {
      agentId: Schema.String,
      turnId: Schema.String,
      ...DeliveredMessage.fields,
      ...TurnSettings.fields,
    },
    error: HostAgentError,
  }),
  /** Answers a request the journal reported waiting. */
  Rpc.make("AnswerRequest", {
    payload: { agentId: Schema.String, requestId: Schema.String, answer: RequestAnswer },
    error: Schema.Union([RequestNotWaiting, HostAgentError]),
  }),
  Rpc.make("Steer", {
    payload: { agentId: Schema.String, ...DeliveredMessage.fields },
    error: HostAgentError,
  }),
  /**
   * Ends the running Turn as stopped, answering with the Steers the program hadn't taken in yet, or
   * `null` when no Turn was running.
   */
  Rpc.make("StopTurn", {
    payload: { agentId: Schema.String },
    success: Schema.NullOr(Schema.Array(SentMessage)),
  }),
  /** Ends the agent program, and with it any running Turn, without reporting it. */
  Rpc.make("StopAgent", { payload: { agentId: Schema.String } }),
  /** Every change in the folder since it forked from `baseRef`, uncommitted and untracked work included. */
  Rpc.make("GetChanges", {
    payload: { folder: HostFolder, baseRef: Schema.String },
    success: Schema.Array(ChangedFile),
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
