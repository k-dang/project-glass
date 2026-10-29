import type { SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  type AgentEvent,
  applyAgentEvent,
  endTurnEvents,
  PartAppended,
  PartSet,
  type RequestAnswer,
  type RequestPart,
  SteerPart,
  TextPart,
  ThinkingPart,
  type Turn,
  TurnDone,
  type TurnEnding,
  TurnFailed,
  type TurnPart,
  TurnStopped,
  type SentMessage,
  sentOf,
} from "@glass/contracts"
import { Data, type DateTime, Option, Schema } from "effect"
import { saysSignInFailed } from "../agentFailure"
import { settledEvent } from "./requests"
import type { Steer, Steering, TurnMachine } from "./turnLoop"
import { runningToolCall, ToolInput, toolOutput } from "./toolCalls"

export type Input = Data.TaggedEnum<{
  Message: { readonly message: SDKMessage }
  Asked: { readonly part: RequestPart }
  /** A `null` answer leaves the request no longer answerable. */
  Settled: { readonly requestId: string; readonly answer: RequestAnswer | null }
  Exited: {}
}>

export const Input = Data.taggedEnum<Input>()

/**
 * Whether a run's replies carry the uuids of the messages they answer, which shows when Claude Code
 * takes a Steer in. The run's first reply tells; a Claude Code too old to stamp never does.
 */
type Stamping = "unknown" | "stamped" | "unstamped"

export interface TurnState extends Steering {
  readonly turn: Turn
  readonly partByBlock: ReadonlyMap<number, number>
  readonly toolCalls: ReadonlyMap<string, number>
  readonly stamping: Stamping
  readonly earlierRunFailure: TurnEnding | null
}

interface Step {
  readonly state: TurnState | null
  readonly events: ReadonlyArray<AgentEvent>
}

export const stoppedReason =
  "Claude Code stopped unexpectedly. Check its installation, then send your message again."

export const beginTurn = (turnId: string, sent: SentMessage, at: DateTime.Utc): TurnState => ({
  turn: { id: turnId, ...sent, sentAt: at, ended: null, parts: [] },
  partByBlock: new Map(),
  toolCalls: new Map(),
  steers: [],
  stopping: false,
  stamping: "unknown",
  earlierRunFailure: null,
})

/** Claude Code reports a failed API call as a `success` marked `is_error`. */
export const isFailure = (message: SDKMessage): message is SDKResultMessage =>
  message.type === "result" && (message.subtype !== "success" || message.is_error)

const endingOf = (result: SDKResultMessage): TurnEnding => {
  if (!isFailure(result)) return TurnDone.make({})

  const [said, status] =
    result.subtype === "success"
      ? [result.result, result.api_error_status]
      : [result.errors.join("\n"), null]

  return TurnFailed.make({
    reason:
      status === 401 || status === 403 || saysSignInFailed(said)
        ? "Claude Code couldn't sign in. Run claude in a terminal to sign in, then send your message again."
        : "Claude Code stopped with an error. Glass's backend log has the details; send your message again to retry.",
  })
}

const isMainThreadReply = (message: SDKMessage) =>
  (message.type === "stream_event" || message.type === "assistant") &&
  message.parent_tool_use_id === null

const decodeToolInput = Schema.decodeUnknownOption(ToolInput)

const Answered = Schema.Struct({
  user_message_uuid: Schema.optional(Schema.String),
  user_message_uuids: Schema.optional(Schema.Array(Schema.String)),
})

const decodeAnswered = Schema.decodeUnknownOption(Answered)

const answered = (message: SDKMessage): ReadonlyArray<string> =>
  Option.match(decodeAnswered(message), {
    onNone: () => [],
    onSome: ({ user_message_uuid, user_message_uuids }) =>
      user_message_uuids ?? (user_message_uuid === undefined ? [] : [user_message_uuid]),
  })

type ToolResult = Extract<
  Exclude<SDKUserMessage["message"]["content"], string>[number],
  { readonly type: "tool_result" }
>

const resultText = (content: ToolResult["content"]) =>
  toolOutput(
    Schema.is(Schema.String)(content)
      ? content
      : (content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
  )

const streamedText = (delta: {
  readonly type: string
  readonly text?: string
  readonly thinking?: string
}) => {
  switch (delta.type) {
    case "text_delta":
      return delta.text ?? ""
    case "thinking_delta":
      return delta.thinking ?? ""
    default:
      return ""
  }
}

export const step = (current: TurnState | null, input: Input, now: DateTime.Utc): Step => {
  if (current === null) return { state: null, events: [] }

  let state: TurnState = current
  let ended = false
  const events: Array<AgentEvent> = []

  const emit = (event: AgentEvent) => {
    events.push(event)
    state = { ...state, turn: applyAgentEvent([state.turn], event)[0] ?? state.turn }
  }

  const addPart = (part: TurnPart) => {
    const index = state.turn.parts.length
    emit(PartSet.make({ turnId: state.turn.id, index, part }))

    return index
  }

  const end = (ending: TurnEnding) => {
    for (const event of endTurnEvents(state.turn.id, state.turn.parts, { at: now, ending }))
      emit(event)
    ended = true
  }

  const onStreamEvent = (event: Extract<SDKMessage, { type: "stream_event" }>["event"]) => {
    switch (event.type) {
      case "message_start":
        state = { ...state, partByBlock: new Map() }
        break
      case "content_block_start": {
        const block = event.content_block

        if (block.type !== "text" && block.type !== "thinking") break

        const index = addPart(
          block.type === "text" ? TextPart.make({ text: "" }) : ThinkingPart.make({ text: "" }),
        )

        state = { ...state, partByBlock: new Map(state.partByBlock).set(event.index, index) }
        break
      }

      case "content_block_delta": {
        const index = state.partByBlock.get(event.index)
        const text = streamedText(event.delta)

        if (index !== undefined && text !== "")
          emit(PartAppended.make({ turnId: state.turn.id, index, text }))
      }
    }
  }

  const takeIn = (message: SDKMessage) => {
    const stamped = answered(message)

    if (state.stamping === "unknown" && isMainThreadReply(message))
      state = { ...state, stamping: stamped.length > 0 ? "stamped" : "unstamped" }

    if (stamped.length === 0) return

    showSteers(state.steers.filter(({ id }) => stamped.includes(id)))
  }

  const showSteers = (taken: ReadonlyArray<Steer>) => {
    for (const steer of taken) addPart(SteerPart.make(sentOf(steer)))

    state = { ...state, steers: state.steers.filter((steer) => !taken.includes(steer)) }
  }

  const onResult = (result: SDKResultMessage) => {
    if (state.stopping) return end(TurnStopped.make({}))

    const ending = endingOf(result)
    const earlierRunFailure = state.earlierRunFailure ?? (isFailure(result) ? ending : null)

    const lateSteerStartsNextRun = state.steers.length > 0 && state.stamping !== "unstamped"

    if (lateSteerStartsNextRun) {
      state = { ...state, stamping: "unknown", earlierRunFailure }

      return undefined
    }

    showSteers(state.steers)

    return end(earlierRunFailure ?? ending)
  }

  const onMessage = (message: SDKMessage) => {
    takeIn(message)

    switch (message.type) {
      case "stream_event":
        if (message.parent_tool_use_id === null) onStreamEvent(message.event)
        break
      case "assistant":
        for (const block of message.message.content) {
          if (block.type !== "tool_use" || state.toolCalls.has(block.id)) continue

          const index = addPart(
            runningToolCall(
              block.id,
              block.name,
              Option.getOrElse(decodeToolInput(block.input), () => ({})),
              message.parent_tool_use_id,
            ),
          )

          state = { ...state, toolCalls: new Map(state.toolCalls).set(block.id, index) }
        }

        break
      case "user": {
        const { content } = message.message

        if (Schema.is(Schema.String)(content)) break

        for (const block of content) {
          if (block.type !== "tool_result") continue
          const index = state.toolCalls.get(block.tool_use_id)
          const part = index === undefined ? undefined : state.turn.parts[index]

          if (index !== undefined && part?._tag === "ToolCall")
            emit(
              PartSet.make({
                turnId: state.turn.id,
                index,
                part: {
                  ...part,
                  output: resultText(block.content),
                  status: block.is_error === true ? "failed" : "done",
                },
              }),
            )
        }

        break
      }

      case "result":
        onResult(message)
    }
  }

  Input.$match(input, {
    Message: ({ message }) => onMessage(message),
    Asked: ({ part }) => {
      addPart(part)
    },
    Settled: ({ requestId, answer }) => {
      const settled = settledEvent(state.turn, requestId, answer)

      if (settled !== undefined) emit(settled)
    },
    Exited: () => end(TurnFailed.make({ reason: stoppedReason })),
  })

  return { state: ended ? null : state, events }
}

export const machine: TurnMachine<TurnState, Input, never> = {
  step,
  begin: beginTurn,
  exitInput: Input.Exited(),
  stoppedReason,
}
