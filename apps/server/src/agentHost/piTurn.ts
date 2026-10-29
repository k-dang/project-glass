import {
  type AgentEvent,
  applyAgentEvent,
  endTurnEvents,
  PartAppended,
  PartSet,
  QuestionPart,
  type RequestAnswer,
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
import { Data, type DateTime, Predicate } from "effect"
import type { AssistantUpdate, ClearedQueue, PiEvent, ToolResult } from "./piRpc"
import { saysSignInFailed } from "../agentFailure"
import { settledEvent } from "./requests"
import type { Steer, Steering, TurnMachine } from "./turnLoop"
import { runningToolCall, type ToolInput, toolOutput } from "./toolCalls"

export type Input = Data.TaggedEnum<{
  Event: { readonly event: PiEvent }
  Accepted: { readonly turnId: string; readonly handled: boolean }
  Refused: { readonly turnId: string }
  Idle: { readonly idle: boolean; readonly generation: number }
  /** A `null` answer leaves the dialog no longer answerable. */
  Settled: { readonly requestId: string; readonly answer: RequestAnswer | null }
  SteerHandled: { readonly id: string }
  Exited: {}
}>

export const Input = Data.taggedEnum<Input>()

export type Command = Data.TaggedEnum<{
  CheckIdle: { readonly generation: number }
  DeclineDialog: { readonly id: string }
  /** Starts pi on the Steers it went idle holding, which pi only sends with a later prompt. */
  Resume: { readonly turnId: string; readonly steers: ReadonlyArray<Steer> }
}>

export const Command = Data.taggedEnum<Command>()

export interface TurnState extends Steering {
  readonly turn: Turn
  readonly partByBlock: ReadonlyMap<number, number>
  readonly toolCalls: ReadonlyMap<string, number>
  readonly providerError: string | null
  readonly generation: number
  readonly promptTakenIn: boolean
}

interface Step {
  readonly state: TurnState | null
  readonly events: ReadonlyArray<AgentEvent>
  readonly commands: ReadonlyArray<Command>
}

export const dialogMethods = new Set(["select", "confirm", "input", "editor"])

const confirmOptions = ["Yes", "No"]

type Dialog = Extract<PiEvent, { readonly type: "extension_ui_request" }>

/** An extension's dialog as a Question: a choice from options, a yes or no, or text. */
export const dialogQuestion = (dialog: Dialog) =>
  QuestionPart.make({
    requestId: dialog.id,
    questions: [
      {
        header: null,
        question: dialog.title ?? "",
        detail: dialog.message ?? null,
        options: (dialog.method === "confirm" ? confirmOptions : (dialog.options ?? [])).map(
          (label) => ({ label, description: null }),
        ),
        multiSelect: false,
        freeText: dialog.method === "input" || dialog.method === "editor",
      },
    ],
    status: "waiting",
    answers: null,
  })

export const stoppedReason =
  "pi stopped unexpectedly. Check its installation, then send your message again."

const refusedReason = "pi didn't accept the message. Send it again."

export const beginTurn = (turnId: string, sent: SentMessage, at: DateTime.Utc): TurnState => ({
  turn: { id: turnId, ...sent, sentAt: at, ended: null, parts: [] },
  partByBlock: new Map(),
  toolCalls: new Map(),
  providerError: null,
  generation: 0,
  steers: [],
  promptTakenIn: false,
  stopping: false,
})

const outputText = (result: ToolResult) =>
  toolOutput(
    result.content.flatMap((block) => (block.text === undefined ? [] : [block.text])).join("\n"),
  )

const failureReason = (providerError: string) =>
  saysSignInFailed(providerError)
    ? "pi couldn't sign in to its model provider. Run pi in a terminal to sign in, then send your message again."
    : "pi's model provider returned an error. Check pi's model and its provider, then send your message again."

const emptyBlock = (type: string): TurnPart =>
  type.startsWith("text") ? TextPart.make({ text: "" }) : ThinkingPart.make({ text: "" })

export const step = (current: TurnState | null, input: Input, now: DateTime.Utc): Step => {
  let state = current
  const events: Array<AgentEvent> = []
  const commands: Array<Command> = []

  const emit = (event: AgentEvent) => {
    events.push(event)

    if (state !== null)
      state = { ...state, turn: applyAgentEvent([state.turn], event)[0] ?? state.turn }
  }

  const setPart = (turn: TurnState, index: number, part: TurnPart) =>
    emit(PartSet.make({ turnId: turn.turn.id, index, part }))

  const blockPart = (turn: TurnState, block: number, type: string) => {
    const known = turn.partByBlock.get(block)

    if (known !== undefined) return known
    const index = turn.turn.parts.length
    state = { ...turn, partByBlock: new Map(turn.partByBlock).set(block, index) }
    setPart(state, index, emptyBlock(type))

    return index
  }

  const startToolCall = (turn: TurnState, toolCallId: string, name: string, args: ToolInput) => {
    if (turn.toolCalls.has(toolCallId)) return
    const index = turn.turn.parts.length
    state = { ...turn, toolCalls: new Map(turn.toolCalls).set(toolCallId, index) }

    setPart(state, index, runningToolCall(toolCallId, name, args, null))
  }

  const end = (turn: TurnState, ending: TurnEnding) => {
    for (const event of endTurnEvents(turn.turn.id, turn.turn.parts, { at: now, ending }))
      emit(event)
    state = null
  }

  const finish = (turn: TurnState, ending: TurnEnding) =>
    end(turn, turn.stopping ? TurnStopped.make({}) : ending)

  const showSteer = (turn: TurnState, steer: Steer) => {
    state = { ...turn, steers: turn.steers.filter((sent) => sent !== steer) }
    setPart(state, turn.turn.parts.length, SteerPart.make(sentOf(steer)))
  }

  const takeIn = (turn: TurnState) => {
    const [steer] = turn.steers

    if (!turn.promptTakenIn) state = { ...turn, promptTakenIn: true }
    else if (steer !== undefined) showSteer(turn, steer)
  }

  const update = (turn: TurnState, change: AssistantUpdate) => {
    if (change.type === "toolcall_end") {
      startToolCall(turn, change.toolCall.id, change.toolCall.name, change.toolCall.arguments)

      return
    }

    const index = blockPart(turn, change.contentIndex, change.type)
    const part = state?.turn.parts[index]

    if (!Predicate.isTagged(part, "Text") && !Predicate.isTagged(part, "Thinking")) return

    if ("delta" in change && change.delta !== "")
      emit(PartAppended.make({ turnId: turn.turn.id, index, text: change.delta }))

    if ("content" in change && part.text !== change.content)
      setPart(turn, index, { ...part, text: change.content })
  }

  const onEvent = (turn: TurnState, event: PiEvent) => {
    switch (event.type) {
      case "agent_start":
        state = { ...turn, generation: turn.generation + 1 }
        break
      // pi's `agent_end` only closes one run that retries or queued work can follow, and an
      // extension can start more work as pi settles, so settling asks whether pi is idle.
      case "agent_settled":
        commands.push(Command.CheckIdle({ generation: turn.generation }))
        break
      case "message_start":
        if (event.message.role === "assistant") state = { ...turn, partByBlock: new Map() }

        if (event.message.role === "user") takeIn(turn)
        break
      case "message_end":
        if (event.message.role === "assistant")
          state = {
            ...turn,
            providerError:
              event.message.stopReason === "error"
                ? (event.message.errorMessage ?? "unknown error")
                : null,
          }
        break
      case "message_update":
        update(turn, event.assistantMessageEvent)
        break
      case "tool_execution_start":
        startToolCall(turn, event.toolCallId, event.toolName, event.args)
        break
      case "tool_execution_end": {
        const index = turn.toolCalls.get(event.toolCallId)
        const part = index === undefined ? undefined : turn.turn.parts[index]

        if (index !== undefined && Predicate.isTagged(part, "ToolCall"))
          setPart(turn, index, {
            ...part,
            output: outputText(event.result),
            status: event.isError ? "failed" : "done",
          })
        break
      }

      case "extension_ui_request":
    }
  }

  Input.$match(input, {
    Event: ({ event }) => {
      if (event.type === "extension_ui_request" && dialogMethods.has(event.method)) {
        if (state === null) commands.push(Command.DeclineDialog({ id: event.id }))
        else setPart(state, state.turn.parts.length, dialogQuestion(event))
      }

      if (state !== null) onEvent(state, event)
    },
    Settled: ({ requestId, answer }) => {
      const settled = state === null ? undefined : settledEvent(state.turn, requestId, answer)

      if (settled !== undefined) emit(settled)
    },
    Accepted: ({ turnId, handled }) => {
      if (handled && state?.turn.id === turnId) finish(state, TurnDone.make({}))
    },
    Refused: ({ turnId }) => {
      if (state?.turn.id === turnId) finish(state, TurnFailed.make({ reason: refusedReason }))
    },
    Idle: ({ idle, generation }) => {
      if (state === null || !idle || generation !== state.generation) return

      if (state.steers.length > 0 && !state.stopping) {
        commands.push(Command.Resume({ turnId: state.turn.id, steers: state.steers }))

        return
      }

      finish(
        state,
        state.providerError === null
          ? TurnDone.make({})
          : TurnFailed.make({ reason: failureReason(state.providerError) }),
      )
    },
    SteerHandled: ({ id }) => {
      const steer = state?.steers.find((sent) => sent.id === id)

      if (state !== null && steer !== undefined) showSteer(state, steer)
    },
    Exited: () => {
      if (state !== null) end(state, TurnFailed.make({ reason: stoppedReason }))
    },
  })

  return { state, events, commands }
}

/**
 * What pi held when it stopped. pi takes Steers in the order they were sent, so the ones it cleared
 * are Glass's newest; they come back as the user wrote them, before pi expanded any template, with
 * their images. Anything else pi held, such as an extension's follow-up, comes back as pi's text.
 */
export const leftover = (
  steers: ReadonlyArray<Steer>,
  cleared: typeof ClearedQueue.Type,
): ReadonlyArray<SentMessage> => {
  const ours = steers.slice(Math.max(0, steers.length - cleared.steering.length))

  const others = [
    ...cleared.steering.slice(0, cleared.steering.length - ours.length),
    ...cleared.followUp,
  ]

  return [...ours.map(sentOf), ...others.map((message) => ({ message, images: [] }))]
}

export const machine: TurnMachine<TurnState, Input, Command> = {
  step,
  begin: beginTurn,
  exitInput: Input.Exited(),
  stoppedReason,
}
