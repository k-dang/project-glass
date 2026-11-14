import {
  AllowRequest,
  DenyRequest,
  AnswerQuestion,
  withContextOf,
  isRequestPart,
  isWaiting,
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
  TurnFailed,
  type TurnPart,
  TurnStopped,
} from "@glass/contracts"
import type {
  Event,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
} from "@opencode-ai/sdk/v2/client"
import { Data, type DateTime, Schema, Predicate, Option } from "effect"
import { isDeepStrictEqual } from "node:util"
import { answeredEvent, expiredEvent } from "./requests"
import { permissionRequest, runningToolCall, ToolInput, toolOutput } from "./toolCalls"
import type { Steering, TurnMachine } from "./turnLoop"

export type History = ReadonlyArray<{ readonly info: Message; readonly parts: ReadonlyArray<Part> }>

export type Input = Data.TaggedEnum<{
  Native: { readonly event: Event }
  Prompt: { readonly turnId: string; readonly messageID: string }
  Delivered: { readonly turnId: string; readonly messageID: string }
  Snapshot: {
    readonly turnId: string
    readonly history: History
    readonly busy: boolean
    readonly delivering: boolean
    readonly permissions: ReadonlyArray<PermissionRequest>
    readonly questions: ReadonlyArray<QuestionRequest>
  }
  Answered: { readonly requestId: string; readonly answer: RequestAnswer }
  Failed: { readonly turnId: string; readonly reason: string }
  Stopped: { readonly turnId: string }
  Exited: {}
}>

export const Input = Data.taggedEnum<Input>()

export interface State extends Steering {
  readonly turn: Turn
  readonly roots: ReadonlySet<string>
  readonly users: ReadonlySet<string>
  readonly assistants: ReadonlySet<string>
  readonly parts: ReadonlyMap<string, number>
  readonly aborted: boolean
  readonly seen: Set<string>
  readonly error: string | null
}

export const stoppedReason =
  "OpenCode stopped unexpectedly. Check its installation, then send your message again."

const questionPart = (request: QuestionRequest) =>
  QuestionPart.make({
    requestId: request.id,
    status: "waiting",
    answers: null,
    questions: request.questions.map((q) => ({
      header: q.header,
      question: q.question,
      detail: null,
      options: q.options,
      multiSelect: q.multiple ?? false,
      freeText: q.custom !== false,
    })),
  })

export const machine: TurnMachine<State, Input, "Reconcile"> = {
  stoppedReason,
  exitInput: Input.Exited(),
  begin: (id, sent, sentAt) => ({
    turn: { id, ...sent, feedback: [], sentAt, ended: null, parts: [] },
    roots: new Set(),
    users: new Set(),
    assistants: new Set(),
    parts: new Map(),
    error: null,
    aborted: false,
    seen: new Set(),
    steers: [],
    stopping: false,
  }),
  step: (current, incoming, now: DateTime.Utc) => {
    let state = current
    const events: Array<AgentEvent> = []
    const commands: Array<"Reconcile"> = []

    const emit = (event: AgentEvent) => {
      events.push(event)

      if (state !== null) state = { ...state, turn: applyAgentEvent([state.turn], event)[0]! }
    }

    const part = (id: string, value: TurnPart) => {
      if (state === null) return
      const index = state.parts.get(id) ?? state.turn.parts.length
      const previous = state.turn.parts[index]

      if (isDeepStrictEqual(previous, value)) return

      if (
        isRequestPart(value) &&
        previous !== undefined &&
        isRequestPart(previous) &&
        !isWaiting(previous)
      )
        return
      state = { ...state, parts: new Map(state.parts).set(id, index) }
      emit(PartSet.make({ turnId: state.turn.id, index, part: value }))
    }

    const end = (reason?: string) => {
      if (state === null) return

      const ending =
        state.stopping || state.aborted
          ? TurnStopped.make({})
          : reason === undefined
            ? TurnDone.make({})
            : TurnFailed.make({ reason })

      for (const event of endTurnEvents(state.turn.id, state.turn.parts, { at: now, ending }))
        emit(event)
      state = null
    }

    const message = (info: Message) => {
      if (state === null) return

      if (info.role === "user") {
        // The root prompt anchors the stream/history. OpenCode can then append its
        // own prompts for compaction and subtask Commands within this same run.
        if (state.roots.has(info.id) || state.users.size > 0)
          state = {
            ...state,
            roots: new Set(state.roots).add(info.id),
            users: new Set(state.users).add(info.id),
          }

        return
      }

      if (!state.roots.has(info.parentID)) return
      state = { ...state, assistants: new Set(state.assistants).add(info.id) }
      const taken = new Set<string>()

      for (const id of state.users) {
        taken.add(id)

        if (id === info.parentID) break
      }

      if (!state.users.has(info.parentID)) taken.clear()
      taken.add(info.parentID)

      for (const steer of state.steers.filter(({ id }) => taken.has(id))) {
        state = { ...state, steers: state.steers.filter(({ id }) => id !== steer.id) }
        part(`steer:${steer.id}`, SteerPart.make(withContextOf(steer)))
      }

      if (info.error?.name === "MessageAbortedError") state = { ...state, aborted: true }

      if (info.error === undefined && info.time.completed !== undefined)
        state = { ...state, error: null }

      if (info.error !== undefined && info.error.name !== "MessageAbortedError")
        state = {
          ...state,
          error:
            info.error.name === "UnknownError"
              ? "OpenCode failed. Check its model, login and configuration, then retry."
              : `OpenCode: ${Predicate.isString(info.error.data.message) ? info.error.data.message : info.error.name}`,
        }
    }

    const nativePart = (value: Part) => {
      if (state === null || !state.assistants.has(value.messageID)) return

      switch (value.type) {
        case "text":
          part(value.id, TextPart.make({ text: value.text }))
          break
        case "reasoning":
          part(value.id, ThinkingPart.make({ text: value.text }))
          break
        case "tool": {
          const args = Schema.decodeUnknownOption(ToolInput)(value.state.input)

          let tool = runningToolCall(
            value.callID,
            value.tool,
            Option.getOrElse(args, () => ({})),
            null,
          )

          if (value.state.status === "completed")
            tool = { ...tool, status: "done", output: toolOutput(value.state.output) }
          else if (value.state.status === "error")
            tool = { ...tool, status: "failed", output: toolOutput(value.state.error) }
          part(value.id, tool)
          break
        }
      }
    }

    if (state === null) return { state, events, commands }

    Input.$match(incoming, {
      Prompt: (input) => {
        if (state === null || state.turn.id !== input.turnId) return
        state = {
          ...state,
          roots: new Set(state.roots).add(input.messageID),
        }
      },
      Delivered: (input) => {
        if (state === null || state.turn.id !== input.turnId) return
        commands.push("Reconcile")
      },
      Exited: () => {
        if (state === null) return
        end(stoppedReason)
      },
      Stopped: (input) => {
        if (state === null) return

        if (state.turn.id === input.turnId) {
          state = { ...state, stopping: true }
          end()
        }
      },
      Failed: (input) => {
        if (state === null) return

        if (state.turn.id === input.turnId) end(input.reason)
      },
      Answered: (input) => {
        if (state === null) return
        const event = answeredEvent(state.turn, input.requestId, input.answer)

        if (event !== undefined) emit(event)
      },
      Snapshot: (input) => {
        if (state === null) return

        if (state.turn.id !== input.turnId) return

        for (const entry of input.history) {
          message(entry.info)

          for (const value of entry.parts) nativePart(value)
        }

        for (const request of input.permissions) {
          part(
            request.id,
            permissionRequest(request.id, request.permission, { patterns: request.patterns }),
          )
        }

        for (const request of input.questions) {
          part(request.id, questionPart(request))
        }

        const latest = input.history.findLast(
          ({ info }) => info.role === "assistant" && state?.assistants.has(info.id),
        )?.info

        // OpenCode publishes idle before failed-message cleanup records its completion.
        if (
          !state.stopping &&
          !input.delivering &&
          state.steers.length === 0 &&
          !input.busy &&
          latest?.role === "assistant" &&
          latest.time.completed !== undefined
        )
          end(state.error ?? undefined)
      },
      Native: (input) => {
        if (state === null) return
        const event = input.event

        if (Predicate.isString(event.id)) {
          if (state.seen.has(event.id)) return
          // One runTurns owner processes this per-Turn set sequentially.
          state.seen.add(event.id)
        }

        switch (event.type) {
          case "message.updated":
            message(event.properties.info)

            if (
              event.properties.info.role === "assistant" &&
              state.assistants.has(event.properties.info.id) &&
              event.properties.info.error !== undefined &&
              event.properties.info.time.completed !== undefined
            )
              commands.push("Reconcile")
            break
          case "message.part.updated":
            nativePart(event.properties.part)
            break
          case "message.part.delta": {
            const value = event.properties
            const index = state.parts.get(value.partID)

            if (
              index !== undefined &&
              state.assistants.has(value.messageID) &&
              value.field === "text"
            )
              emit(PartAppended.make({ turnId: state.turn.id, index, text: value.delta }))
            break
          }

          case "permission.asked":
            part(
              event.properties.id,
              permissionRequest(event.properties.id, event.properties.permission, {
                patterns: event.properties.patterns,
              }),
            )
            break
          case "question.asked":
            part(event.properties.id, questionPart(event.properties))
            break
          case "permission.replied": {
            const answered = answeredEvent(
              state.turn,
              event.properties.requestID,
              event.properties.reply === "reject"
                ? DenyRequest.make({ reason: null })
                : AllowRequest.make({}),
            )

            if (answered !== undefined) emit(answered)
            break
          }

          case "question.replied": {
            const answered = answeredEvent(
              state.turn,
              event.properties.requestID,
              AnswerQuestion.make({
                answers: event.properties.answers.map((chosen) => ({ chosen, text: null })),
              }),
            )

            if (answered !== undefined) emit(answered)
            break
          }

          case "question.rejected": {
            const expired = expiredEvent(state.turn, event.properties.requestID)

            if (expired !== undefined) emit(expired)
            break
          }

          case "session.error":
            // This event has no prompt identity. The owned HTTP request reports
            // pre-assistant failures; assistant errors carry a correlated parentID.
            break
          case "session.status":
            if (event.properties.status.type === "idle" && state.assistants.size > 0)
              commands.push("Reconcile")
            break
        }
      },
    })

    return { state, events, commands }
  },
}
