import type { FeedbackNote, QueuedMessage, TurnEnding } from "@glass/contracts"
import { Match, Predicate } from "effect"

export interface ConversationState {
  readonly running: string | null
  readonly queued: ReadonlyArray<QueuedMessage>
}

export type ConversationEvent =
  | { readonly type: "send"; readonly message: QueuedMessage }
  | { readonly type: "sendQueued" | "cancelQueued"; readonly queuedId: string }
  | { readonly type: "turnEnded"; readonly ending: TurnEnding }

export type ConversationWrite =
  | { readonly type: "startTurn"; readonly message: QueuedMessage }
  | { readonly type: "enqueue"; readonly message: QueuedMessage }
  | { readonly type: "prepend"; readonly messages: ReadonlyArray<QueuedMessage> }
  | { readonly type: "dequeue"; readonly queuedId: string }

export type ConversationOutcome =
  | { readonly type: "started" | "queued" | "busy" | "unchanged" }
  | { readonly type: "canceled"; readonly feedback: ReadonlyArray<FeedbackNote> }

export interface ConversationStep {
  readonly outcome: ConversationOutcome
  readonly writes: ReadonlyArray<ConversationWrite>
}

const unchanged: ConversationStep = { outcome: { type: "unchanged" }, writes: [] }

const startQueued = (queued: QueuedMessage): ConversationStep => ({
  outcome: { type: "started" },
  writes: [
    { type: "dequeue", queuedId: queued.id },
    { type: "startTurn", message: queued },
  ],
})

export const stepConversation = (
  state: ConversationState,
  event: ConversationEvent,
): ConversationStep =>
  Match.value(event).pipe(
    Match.withReturnType<ConversationStep>(),
    Match.discriminatorsExhaustive("type")({
      send: ({ message }) =>
        state.running === null
          ? { outcome: { type: "started" }, writes: [{ type: "startTurn", message }] }
          : { outcome: { type: "queued" }, writes: [{ type: "enqueue", message }] },
      sendQueued: ({ queuedId }) => {
        if (state.running !== null) return { outcome: { type: "busy" }, writes: [] }

        const chosen = state.queued.find(({ id }) => id === queuedId)

        return chosen === undefined ? unchanged : startQueued(chosen)
      },
      cancelQueued: ({ queuedId }) => {
        const canceled = state.queued.find(({ id }) => id === queuedId)

        return canceled === undefined
          ? unchanged
          : {
              outcome: { type: "canceled", feedback: canceled.feedback },
              writes: [{ type: "dequeue", queuedId }],
            }
      },
      turnEnded: ({ ending }) => {
        const [head] = state.queued

        return state.running === null &&
          head !== undefined &&
          (Predicate.isTagged(ending, "Done") || Predicate.isTagged(ending, "Failed"))
          ? startQueued(head)
          : unchanged
      },
    }),
  )
