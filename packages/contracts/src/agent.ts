import { agentEngines } from "@glass/plugin"
import { Match, Predicate, Schema } from "effect"
import { FeedbackNote } from "./feedbackNote"
import { FollowedRepository } from "./followedRepository"
import { ChangedFile, PullRequestRef } from "./pullRequest"
import { Revision } from "./revision"

export const AgentEngine = Schema.Literals(agentEngines)

export type AgentEngine = typeof AgentEngine.Type

export const LocalPlace = Schema.TaggedStruct("local", {})

export const SandboxPlace = Schema.TaggedStruct("sandbox", { providerId: Schema.String })

export const PlaceTag = Schema.Literals([
  LocalPlace.fields._tag.schema.literal,
  SandboxPlace.fields._tag.schema.literal,
])

export type PlaceTag = typeof PlaceTag.Type

export const AgentPlace = Schema.Union([LocalPlace, SandboxPlace])

export type AgentPlace = typeof AgentPlace.Type

export const localPlace: AgentPlace = LocalPlace.make({})

export const asksPermission = (place: AgentPlace) => Predicate.isTagged(place, "local")

export class LocalCheckout extends Schema.Class<LocalCheckout>("LocalCheckout")({
  repository: FollowedRepository,
  path: Schema.String,
}) {}

export class Branches extends Schema.Class<Branches>("Branches")({
  defaultBranch: Schema.NullOr(Schema.String),
  branches: Schema.Array(Schema.String),
}) {}

export const AgentModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  efforts: Schema.Array(Schema.String),
})

export type AgentModel = typeof AgentModel.Type

export const PermissionMode = Schema.Literals([
  "default",
  "acceptEdits",
  "auto",
  "bypassPermissions",
])

export type PermissionMode = typeof PermissionMode.Type

export const defaultPermissionMode: PermissionMode = "auto"

export interface AgentCapabilities {
  readonly permissionModes: ReadonlyArray<PermissionMode>
}

export const engineCapabilities: Record<AgentEngine, AgentCapabilities> = {
  "claude-code": { permissionModes: PermissionMode.literals },
  pi: { permissionModes: [] },
}

export const AgentCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
})

export type AgentCommand = typeof AgentCommand.Type

export class AgentModels extends Schema.Class<AgentModels>("AgentModels")({
  defaultModel: Schema.NullOr(AgentModel),
  models: Schema.Array(AgentModel),
}) {}

export const ModelChoice = Schema.Struct({
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
})

export type ModelChoice = typeof ModelChoice.Type

export const GoneReach = Schema.Literals(["expired", "deleted"])

export type GoneReach = typeof GoneReach.Type

export const SandboxReach = Schema.Literals([
  "connecting",
  "reachable",
  "unreachable",
  ...GoneReach.literals,
])

export type SandboxReach = typeof SandboxReach.Type

export const isGone = Schema.is(GoneReach)

export const isOutOfReach = (reach: SandboxReach) => reach === "unreachable" || isGone(reach)

export const goneExplanation = (reach: GoneReach) =>
  `This Agent's Sandbox ${reach === "expired" ? "expired" : "was deleted"}, so it can't take messages. Its transcript stays until you remove the Agent.`

export class SandboxStatus extends Schema.Class<SandboxStatus>("SandboxStatus")({
  expiresAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  reach: SandboxReach,
}) {}

export const AgentSkillPack = Schema.Struct({ name: Schema.String, commit: Schema.String })

export type AgentSkillPack = typeof AgentSkillPack.Type

export class Agent extends Schema.Class<Agent>("Agent")({
  id: Schema.String,
  name: Schema.String,
  place: AgentPlace,
  repository: FollowedRepository,
  baseBranch: Schema.String,
  engine: AgentEngine,
  ...ModelChoice.fields,
  permissionMode: Schema.NullOr(PermissionMode),
  skillPacks: Schema.Array(AgentSkillPack),
  localSkills: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromString,
  sandbox: Schema.NullOr(SandboxStatus),
}) {}

export const ImageMediaType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
])

export type ImageMediaType = typeof ImageMediaType.Type

export const Image = Schema.Struct({ mediaType: ImageMediaType, data: Schema.String })

export type Image = typeof Image.Type

export const SentMessage = Schema.Struct({ message: Schema.String, images: Schema.Array(Image) })

export type SentMessage = typeof SentMessage.Type

export const sentOf = ({ message, images }: SentMessage): SentMessage => ({ message, images })

export const PullRequestContext = Schema.TaggedStruct("PullRequest", {
  pullRequest: PullRequestRef,
  revision: Revision,
})

export const AgentContext = Schema.TaggedStruct("Agent", {
  agentId: Schema.String,
  name: Schema.String,
})

export const CapturedContext = Schema.Union([PullRequestContext, AgentContext])

export type CapturedContext = typeof CapturedContext.Type

export const MessageWithContext = Schema.Struct({
  ...SentMessage.fields,
  context: Schema.NullOr(CapturedContext),
})

export type MessageWithContext = typeof MessageWithContext.Type

export const withContextOf = ({
  message,
  images,
  context,
}: MessageWithContext): MessageWithContext => ({ message, images, context })

export const AcceptedMessage = Schema.Struct({
  ...MessageWithContext.fields,
  feedback: Schema.Array(FeedbackNote),
})

export type AcceptedMessage = typeof AcceptedMessage.Type

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

export const PermissionRequestPart = Schema.TaggedStruct("PermissionRequest", {
  requestId: Schema.String,
  toolName: Schema.String,
  inputSummary: Schema.String,
  input: Schema.String,
  status: Decision,
  reason: Schema.NullOr(Schema.String),
})

export const AskedQuestion = Schema.Struct({
  header: Schema.NullOr(Schema.String),
  question: Schema.String,
  detail: Schema.NullOr(Schema.String),
  options: Schema.Array(
    Schema.Struct({ label: Schema.String, description: Schema.NullOr(Schema.String) }),
  ),
  multiSelect: Schema.Boolean,
  freeText: Schema.Boolean,
})

export type AskedQuestion = typeof AskedQuestion.Type

export const QuestionReply = Schema.Struct({
  chosen: Schema.Array(Schema.String),
  text: Schema.NullOr(Schema.String),
})

export type QuestionReply = typeof QuestionReply.Type

export const QuestionPart = Schema.TaggedStruct("Question", {
  requestId: Schema.String,
  questions: Schema.Array(AskedQuestion),
  status: Schema.Literals(["waiting", "answered", "expired"]),
  answers: Schema.NullOr(Schema.Array(QuestionReply)),
})

export const SteerPart = Schema.TaggedStruct("Steer", MessageWithContext.fields)

export const TurnPart = Schema.Union([
  TextPart,
  ThinkingPart,
  ToolCallPart,
  SteerPart,
  PermissionRequestPart,
  QuestionPart,
])

export type TurnPart = typeof TurnPart.Type

export type RequestPart = Extract<TurnPart, { readonly requestId: string }>

export const requestPartTags = ["PermissionRequest", "Question"] as const satisfies ReadonlyArray<
  RequestPart["_tag"]
>

export const isRequestPart = (part: TurnPart): part is RequestPart =>
  requestPartTags.some((tag) => tag === part._tag)

export const isWaiting = (part: TurnPart): part is RequestPart =>
  isRequestPart(part) && part.status === "waiting"

export const AllowRequest = Schema.TaggedStruct("Allow", {})

export const DenyRequest = Schema.TaggedStruct("Deny", { reason: Schema.NullOr(Schema.String) })

export const AnswerQuestion = Schema.TaggedStruct("Answer", {
  answers: Schema.Array(QuestionReply),
})

export const RequestAnswer = Schema.Union([AllowRequest, DenyRequest, AnswerQuestion])

export type RequestAnswer = typeof RequestAnswer.Type

const fits = (asked: AskedQuestion, reply: QuestionReply | undefined) =>
  reply !== undefined &&
  reply.chosen.length > 0 !== (reply.text !== null) &&
  (reply.text === null || (asked.freeText && reply.text.trim() !== "")) &&
  (asked.multiSelect || reply.chosen.length <= 1) &&
  reply.chosen.every((label) => asked.options.some((option) => option.label === label))

export const expireRequest = (part: RequestPart): RequestPart => ({ ...part, status: "expired" })

export const answerRequest = (
  part: RequestPart,
  answer: RequestAnswer,
): RequestPart | undefined => {
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

export const TurnFailed = Schema.TaggedStruct("Failed", { reason: Schema.String })

export const TurnStopped = Schema.TaggedStruct("Stopped", {})

export const TurnCutOff = Schema.TaggedStruct("CutOff", {})

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
  ...AcceptedMessage.fields,
  sentAt: Schema.DateTimeUtcFromString,
  ended: Schema.NullOr(TurnEnd),
  parts: Schema.Array(TurnPart),
})

export type Turn = typeof Turn.Type

export const TurnStarted = Schema.TaggedStruct("TurnStarted", {
  turnId: Schema.String,
  ...AcceptedMessage.fields,
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

export const QueuedMessage = Schema.Struct({ id: Schema.String, ...AcceptedMessage.fields })

export type QueuedMessage = typeof QueuedMessage.Type

export const Transcript = Schema.Struct({
  turns: Schema.Array(Turn),
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

    const expired = isWaiting(part) ? expireRequest(part) : undefined

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
      TurnStarted: ({ turnId, message, images, context, feedback, sentAt }) => [
        ...turns,
        { id: turnId, message, images, context, feedback, sentAt, ended: null, parts: [] },
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

export const MessageInputWithContext = Schema.Struct({
  ...MessageInput.fields,
  context: MessageWithContext.fields.context,
})

export type MessageInputWithContext = typeof MessageInputWithContext.Type

const hasContent = Schema.makeFilter(
  ({ message, feedback }: { readonly message: string; readonly feedback: ReadonlyArray<string> }) =>
    message !== "" || feedback.length > 0 || "Write a message or attach Feedback notes",
)

const agentMessageFields = {
  message: Schema.Trimmed,
  images: SentMessage.fields.images,
  feedback: Schema.Array(Schema.String),
}

export const SendAgentMessage = Schema.Struct({
  agentId: Schema.String,
  ...agentMessageFields,
}).check(hasContent)

export type AgentMessageInput = Omit<typeof SendAgentMessage.Type, "agentId">

export const nothingUnsent: SentMessage = { message: "", images: [] }

export const isNothingUnsent = ({ message, images }: SentMessage) =>
  message === "" && images.length === 0

export const MessageDelivery = Schema.Literals(["started", "queued"])

export type MessageDelivery = typeof MessageDelivery.Type

export const NewAgent = Schema.Struct({
  repository: FollowedRepository,
  baseBranch: Schema.String,
  engine: AgentEngine,
  ...ModelChoice.fields,
  permissionMode: Schema.NullOr(PermissionMode),
  place: AgentPlace,
  skillPacks: Schema.Array(Schema.String),
  /** Whether a Sandbox Agent gets the user's Local skills; a local Agent's program reads them itself. */
  localSkills: Schema.Boolean,
  ...MessageInput.fields,
})

export type NewAgent = typeof NewAgent.Type

export class SandboxProviderInfo extends Schema.Class<SandboxProviderInfo>("SandboxProviderInfo")({
  id: Schema.String,
  name: Schema.String,
  engines: Schema.NonEmptyArray(AgentEngine),
}) {}

export class AgentChanges extends Schema.Class<AgentChanges>("AgentChanges")({
  id: Schema.String,
  files: Schema.Array(ChangedFile),
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

export class RequestWaiting extends Schema.TaggedError<RequestWaiting>()("RequestWaiting", {}) {}

export class RequestNotWaiting extends Schema.TaggedError<RequestNotWaiting>()(
  "RequestNotWaiting",
  {},
) {}

export class NoPermissionModes extends Schema.TaggedError<NoPermissionModes>()(
  "NoPermissionModes",
  {},
) {}

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  message: Schema.String,
}) {}
