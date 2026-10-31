import { Match, Predicate, Schema } from "effect"
import { FollowedRepository } from "./followedRepository"

export const AgentEngine = Schema.Literals(["claude-code", "pi-cli"])

export type AgentEngine = typeof AgentEngine.Type

export const ThisMacPlace = Schema.TaggedStruct("this-mac", {})

export const SandboxPlace = Schema.TaggedStruct("sandbox", { providerId: Schema.String })

export const PlaceTag = Schema.Literals([
  ThisMacPlace.fields._tag.schema.literal,
  SandboxPlace.fields._tag.schema.literal,
])

export type PlaceTag = typeof PlaceTag.Type

export const AgentPlace = Schema.Union([ThisMacPlace, SandboxPlace])

export type AgentPlace = typeof AgentPlace.Type

export const thisMac: AgentPlace = ThisMacPlace.make({})

export const asksPermission = (place: AgentPlace) => Predicate.isTagged(place, "this-mac")

export class LocalCheckout extends Schema.Class<LocalCheckout>("LocalCheckout")({
  repository: FollowedRepository,
  path: Schema.String,
}) {}

export class Branches extends Schema.Class<Branches>("Branches")({
  defaultBranch: Schema.NullOr(Schema.String),
  branches: Schema.Array(Schema.String),
}) {}

/** A model an agent program offers, with the efforts it takes, from lowest to highest. */
export const AgentModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  efforts: Schema.Array(Schema.String),
})

export type AgentModel = typeof AgentModel.Type

/** How much a Claude Code Agent asks before it acts: Claude Code's own modes of these names. */
export const PermissionMode = Schema.Literals([
  "default",
  "acceptEdits",
  "auto",
  "bypassPermissions",
])

export type PermissionMode = typeof PermissionMode.Type

/** The mode an Agent starts in unless the user picks another: the one that asks the most. */
export const defaultPermissionMode: PermissionMode = "default"

export interface AgentCapabilities {
  /** Whether a message can go into the running Turn rather than wait for it to end. */
  readonly steer: boolean
  /** The Permission modes the program takes; none for a program that doesn't ask. */
  readonly permissionModes: ReadonlyArray<PermissionMode>
}

export const engineCapabilities: Record<AgentEngine, AgentCapabilities> = {
  "claude-code": { steer: true, permissionModes: PermissionMode.literals },
  "pi-cli": { steer: true, permissionModes: [] },
}

/** What an agent program offers in a place: its models. */

export class AgentModels extends Schema.Class<AgentModels>("AgentModels")({
  /** What a `null` model runs: the program's own default, if it has one. */
  defaultModel: Schema.NullOr(AgentModel),
  models: Schema.Array(AgentModel),
}) {}

/** `null` leaves the choice to the agent program: its default model, or the model's default effort. */
export const ModelChoice = Schema.Struct({
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
})

export type ModelChoice = typeof ModelChoice.Type

export class Agent extends Schema.Class<Agent>("Agent")({
  id: Schema.String,
  /** Also the name of the branch the Agent works on. */
  name: Schema.String,
  place: AgentPlace,
  repository: FollowedRepository,
  baseBranch: Schema.String,
  engine: AgentEngine,
  ...ModelChoice.fields,
  /** `null` for a program without Permission modes. */
  permissionMode: Schema.NullOr(PermissionMode),
  createdAt: Schema.DateTimeUtcFromString,
}) {}

export const ImageMediaType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
])

export type ImageMediaType = typeof ImageMediaType.Type

/** An image attached to a message, its bytes in base64. */
export const Image = Schema.Struct({ mediaType: ImageMediaType, data: Schema.String })

export type Image = typeof Image.Type

export const SentMessage = Schema.Struct({ message: Schema.String, images: Schema.Array(Image) })

export type SentMessage = typeof SentMessage.Type

export const sentOf = ({ message, images }: SentMessage): SentMessage => ({ message, images })

export const TextPart = Schema.TaggedStruct("Text", { text: Schema.String })

export const ThinkingPart = Schema.TaggedStruct("Thinking", { text: Schema.String })

const ToolCallStatus = Schema.Literals(["running", "done", "failed"])

export const ToolCallPart = Schema.TaggedStruct("ToolCall", {
  toolCallId: Schema.String,
  name: Schema.String,
  inputSummary: Schema.String,
  input: Schema.String,
  output: Schema.NullOr(Schema.String),
  status: ToolCallStatus,
  parentToolCallId: Schema.NullOr(Schema.String),
})

const Decision = Schema.Literals(["waiting", "allowed", "denied", "expired"])

/** `reason` is what the user told the Agent when they denied it. */
export const PermissionRequestPart = Schema.TaggedStruct("PermissionRequest", {
  requestId: Schema.String,
  toolName: Schema.String,
  inputSummary: Schema.String,
  input: Schema.String,
  status: Decision,
  reason: Schema.NullOr(Schema.String),
})

export const AskedQuestion = Schema.Struct({
  /** A short label for the question, when the program gives one. */
  header: Schema.NullOr(Schema.String),
  question: Schema.String,
  detail: Schema.NullOr(Schema.String),
  options: Schema.Array(
    Schema.Struct({ label: Schema.String, description: Schema.NullOr(Schema.String) }),
  ),
  multiSelect: Schema.Boolean,
  /** Whether the user may answer in their own words instead of with an option. */
  freeText: Schema.Boolean,
})

export type AskedQuestion = typeof AskedQuestion.Type

/** The user's answer to one question: the options they chose, or their own words. */
export const QuestionReply = Schema.Struct({
  chosen: Schema.Array(Schema.String),
  text: Schema.NullOr(Schema.String),
})

export type QuestionReply = typeof QuestionReply.Type

/** `answers` holds one reply per question once answered. */
export const QuestionPart = Schema.TaggedStruct("Question", {
  requestId: Schema.String,
  questions: Schema.Array(AskedQuestion),
  status: Schema.Literals(["waiting", "answered", "expired"]),
  answers: Schema.NullOr(Schema.Array(QuestionReply)),
})

/** A message the user Steered into the Turn, placed where the agent program took it in. */
export const SteerPart = Schema.TaggedStruct("Steer", SentMessage.fields)

export const TurnPart = Schema.Union([
  TextPart,
  ThinkingPart,
  ToolCallPart,
  SteerPart,
  PermissionRequestPart,
  QuestionPart,
])

export type TurnPart = typeof TurnPart.Type

/** A Permission request or a Question: a part the user answers. */
export type RequestPart = Extract<TurnPart, { readonly requestId: string }>

/** Transcripts' SQL finds request parts by these tags too. */
export const isRequestPart = (part: TurnPart): part is RequestPart =>
  Predicate.isTagged(part, "PermissionRequest") || Predicate.isTagged(part, "Question")

export const isWaiting = (part: TurnPart): part is RequestPart =>
  isRequestPart(part) && part.status === "waiting"

export const AllowRequest = Schema.TaggedStruct("Allow", {})

export const DenyRequest = Schema.TaggedStruct("Deny", { reason: Schema.NullOr(Schema.String) })

export const AnswerQuestion = Schema.TaggedStruct("Answer", {
  answers: Schema.Array(QuestionReply),
})

/** Allow or Deny answers a Permission request; Answer answers a Question. */
export const RequestAnswer = Schema.Union([AllowRequest, DenyRequest, AnswerQuestion])

export type RequestAnswer = typeof RequestAnswer.Type

/** One reply answers a question with its own options, or in words where it takes them. */
const fits = (asked: AskedQuestion, reply: QuestionReply | undefined) =>
  reply !== undefined &&
  reply.chosen.length > 0 !== (reply.text !== null) &&
  (reply.text === null || (asked.freeText && reply.text.trim() !== "")) &&
  (asked.multiSelect || reply.chosen.length <= 1) &&
  reply.chosen.every((label) => asked.options.some((option) => option.label === label))

/**
 * The request as it reads once answered, or once it can no longer be answered when `answer` is
 * `null`; `undefined` when the answer doesn't fit the request.
 */
export const settleRequest = (
  part: RequestPart,
  answer: RequestAnswer | null,
): RequestPart | undefined => {
  if (answer === null) return { ...part, status: "expired" }

  if (Predicate.isTagged(part, "Question"))
    return Predicate.isTagged(answer, "Answer") &&
      answer.answers.length === part.questions.length &&
      part.questions.every((asked, index) => fits(asked, answer.answers[index]))
      ? { ...part, status: "answered", answers: answer.answers }
      : undefined

  return Match.value(answer).pipe(
    Match.tagsExhaustive({
      Allow: () => ({ ...part, status: "allowed" as const }),
      Deny: ({ reason }) => ({ ...part, status: "denied" as const, reason }),
      Answer: () => undefined,
    }),
  )
}

export const TurnDone = Schema.TaggedStruct("Done", {})

/** `reason` is written for the user and never carries raw agent output. */
export const TurnFailed = Schema.TaggedStruct("Failed", { reason: Schema.String })

export const TurnStopped = Schema.TaggedStruct("Stopped", {})

/** Glass lost the Agent while the Turn ran. */
export const TurnCutOff = Schema.TaggedStruct("CutOff", {})

/** The Turn was running when Glass quit. */
export const TurnInterrupted = Schema.TaggedStruct("Interrupted", {})

export const TurnEnding = Schema.Union([
  TurnDone,
  TurnFailed,
  TurnStopped,
  TurnCutOff,
  TurnInterrupted,
])

export type TurnEnding = typeof TurnEnding.Type

export const TurnEnd = Schema.Struct({ at: Schema.DateTimeUtcFromString, ending: TurnEnding })

export type TurnEnd = typeof TurnEnd.Type

export const Turn = Schema.Struct({
  id: Schema.String,
  ...SentMessage.fields,
  sentAt: Schema.DateTimeUtcFromString,
  ended: Schema.NullOr(TurnEnd),
  parts: Schema.Array(TurnPart),
})

export type Turn = typeof Turn.Type

export const TurnStarted = Schema.TaggedStruct("TurnStarted", {
  turnId: Schema.String,
  ...SentMessage.fields,
  sentAt: Schema.DateTimeUtcFromString,
})

export const PartSet = Schema.TaggedStruct("PartSet", {
  turnId: Schema.String,
  index: Schema.Int,
  part: TurnPart,
})

export const PartAppended = Schema.TaggedStruct("PartAppended", {
  turnId: Schema.String,
  index: Schema.Int,
  text: Schema.String,
})

export const TurnEnded = Schema.TaggedStruct("TurnEnded", { turnId: Schema.String, ended: TurnEnd })

export const AgentEvent = Schema.Union([TurnStarted, PartSet, PartAppended, TurnEnded])

export type AgentEvent = typeof AgentEvent.Type

export const QueuedMessage = Schema.Struct({ id: Schema.String, ...SentMessage.fields })

export type QueuedMessage = typeof QueuedMessage.Type

export const Transcript = Schema.Struct({
  turns: Schema.Array(Turn),
  /** In the order they start. */
  queued: Schema.Array(QueuedMessage),
  status: Schema.NullOr(Schema.String),
})

export type Transcript = typeof Transcript.Type

export const emptyTranscript: Transcript = { turns: [], queued: [], status: null }

export const TranscriptSnapshot = Schema.TaggedStruct("Snapshot", Transcript.fields)

export const QueuedMessagesChanged = Schema.TaggedStruct("QueuedMessagesChanged", {
  queued: Transcript.fields.queued,
})

export const StatusChanged = Schema.TaggedStruct("StatusChanged", {
  status: Transcript.fields.status,
})

export const TranscriptUpdate = Schema.Union([
  TranscriptSnapshot,
  QueuedMessagesChanged,
  StatusChanged,
  ...AgentEvent.members,
])

export type TranscriptUpdate = typeof TranscriptUpdate.Type

const changeTurn = (
  turns: ReadonlyArray<Turn>,
  turnId: string,
  change: (turn: Turn) => Turn,
): ReadonlyArray<Turn> => turns.map((turn) => (turn.id === turnId ? change(turn) : turn))

const appendText = (part: TurnPart | undefined, text: string) =>
  Predicate.isTagged(part, "Text") || Predicate.isTagged(part, "Thinking")
    ? { ...part, text: part.text + text }
    : part

export const endTurnEvents = (
  turnId: string,
  parts: ReadonlyArray<TurnPart>,
  ended: TurnEnd,
): ReadonlyArray<AgentEvent> => [
  ...parts.flatMap((part, index) => {
    if (Predicate.isTagged(part, "ToolCall") && part.status === "running")
      return [PartSet.make({ turnId, index, part: { ...part, status: "failed" } })]

    const expired = isWaiting(part) ? settleRequest(part, null) : undefined

    return expired === undefined ? [] : [PartSet.make({ turnId, index, part: expired })]
  }),
  TurnEnded.make({ turnId, ended }),
]

export const applyAgentEvent = (
  turns: ReadonlyArray<Turn>,
  event: AgentEvent,
): ReadonlyArray<Turn> =>
  Match.value(event).pipe(
    Match.tagsExhaustive({
      TurnStarted: ({ turnId, message, images, sentAt }) => [
        ...turns,
        { id: turnId, message, images, sentAt, ended: null, parts: [] },
      ],
      PartSet: ({ turnId, index, part }) =>
        changeTurn(turns, turnId, (turn) => {
          const parts = [...turn.parts]
          parts[index] = part

          return { ...turn, parts }
        }),
      PartAppended: ({ turnId, index, text }) =>
        changeTurn(turns, turnId, (turn) => {
          const parts = [...turn.parts]
          const appended = appendText(parts[index], text)

          if (appended !== undefined) parts[index] = appended

          return { ...turn, parts }
        }),
      TurnEnded: ({ turnId, ended }) => changeTurn(turns, turnId, (turn) => ({ ...turn, ended })),
    }),
  )

export const applyTranscriptUpdate = (
  transcript: Transcript,
  update: TranscriptUpdate,
): Transcript =>
  Match.value(update).pipe(
    Match.tag("Snapshot", ({ turns, queued, status }) => ({ turns, queued, status })),
    Match.tag("QueuedMessagesChanged", ({ queued }) => ({ ...transcript, queued })),
    Match.tag("StatusChanged", ({ status }) => ({ ...transcript, status })),
    Match.orElse((event) => ({ ...transcript, turns: applyAgentEvent(transcript.turns, event) })),
  )

export const MessageText = Schema.Trimmed.check(Schema.isNonEmpty())

export const MessageInput = Schema.Struct({ ...SentMessage.fields, message: MessageText })

export type MessageInput = typeof MessageInput.Type

export const nothingUnsent: SentMessage = { message: "", images: [] }

export const isNothingUnsent = ({ message, images }: SentMessage) =>
  message === "" && images.length === 0

export const NewAgent = Schema.Struct({
  repository: FollowedRepository,
  baseBranch: Schema.String,
  engine: AgentEngine,
  ...ModelChoice.fields,
  /** `null` starts a program with Permission modes in `defaultPermissionMode`. */
  permissionMode: Agent.fields.permissionMode,
  place: AgentPlace,
  ...MessageInput.fields,
})

export type NewAgent = typeof NewAgent.Type

export class SandboxProviderInfo extends Schema.Class<SandboxProviderInfo>("SandboxProviderInfo")({
  id: Schema.String,
  name: Schema.String,
  /** The Agent programs its Sandboxes can run. */
  engines: Schema.NonEmptyArray(AgentEngine),
}) {}

export class RemovalWarnings extends Schema.Class<RemovalWarnings>("RemovalWarnings")({
  uncommittedChanges: Schema.Literals(["none", "some", "unchecked"]),
}) {}

export class InvalidLocalCheckout extends Schema.TaggedError<InvalidLocalCheckout>()(
  "InvalidLocalCheckout",
  { message: Schema.String },
) {}

export class AgentNotFound extends Schema.TaggedError<AgentNotFound>()("AgentNotFound", {
  agentId: Schema.String,
}) {}

export class AgentBusy extends Schema.TaggedError<AgentBusy>()("AgentBusy", {}) {}

/** A Permission request or Question waits on the user, who answers it before sending more. */
export class RequestWaiting extends Schema.TaggedError<RequestWaiting>()("RequestWaiting", {}) {}

/** The request was answered already, or its Turn ended. */
export class RequestNotWaiting extends Schema.TaggedError<RequestNotWaiting>()(
  "RequestNotWaiting",
  {},
) {}

/** The Agent's program has no Permission modes. */
export class NoPermissionModes extends Schema.TaggedError<NoPermissionModes>()(
  "NoPermissionModes",
  {},
) {}

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  message: Schema.String,
}) {}
