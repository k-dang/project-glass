import type { FeedbackNote, QueuedMessage, TurnEnding, TurnMessage } from "@glass/contracts"
import { Match, Predicate } from "effect"

export interface ThreadState {
  readonly running: string | null
  readonly queued: ReadonlyArray<QueuedMessage>
}

export type ThreadEvent =
  | { readonly type: "send"; readonly message: QueuedMessage }
  | { readonly type: "startIfIdle"; readonly message: StartingTurn }
  | { readonly type: "sendQueued" | "cancelQueued"; readonly queuedId: string }
  | {
      readonly type: "turnEnded"
      readonly ending: TurnEnding
      readonly requeued: ReadonlyArray<QueuedMessage>
    }

export type StartingTurn = Omit<QueuedMessage, "context"> &
  Pick<TurnMessage, "context"> & { readonly retriesDelivery: boolean }

export type ThreadWrite =
  | { readonly type: "startTurn"; readonly message: StartingTurn }
  | { readonly type: "enqueue"; readonly message: QueuedMessage }
  | { readonly type: "prepend"; readonly messages: ReadonlyArray<QueuedMessage> }
  | { readonly type: "dequeue"; readonly queuedId: string }

type StepOutcome =
  | { readonly type: "started" | "queued" | "busy" | "unchanged" }
  | { readonly type: "canceled"; readonly feedback: ReadonlyArray<FeedbackNote> }

export interface ThreadStep {
  readonly outcome: StepOutcome
  readonly writes: ReadonlyArray<ThreadWrite>
}

const unchanged: ThreadStep = { outcome: { type: "unchanged" }, writes: [] }

const startSent = (message: QueuedMessage): ThreadWrite => ({
  type: "startTurn",
  message: { ...message, retriesDelivery: false },
})

const startQueued = (queued: QueuedMessage): ThreadStep => ({
  outcome: { type: "started" },
  writes: [{ type: "dequeue", queuedId: queued.id }, startSent(queued)],
})

export const stepThread = (state: ThreadState, event: ThreadEvent): ThreadStep =>
  Match.value(event).pipe(
    Match.withReturnType<ThreadStep>(),
    Match.discriminatorsExhaustive("type")({
      startIfIdle: ({ message }) =>
        state.running === null && state.queued.length === 0
          ? { outcome: { type: "started" }, writes: [{ type: "startTurn", message }] }
          : { outcome: { type: "busy" }, writes: [] },
      send: ({ message }) =>
        state.running === null
          ? { outcome: { type: "started" }, writes: [startSent(message)] }
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
      turnEnded: ({ ending, requeued }) => {
        if (requeued.length > 0)
          return { outcome: { type: "queued" }, writes: [{ type: "prepend", messages: requeued }] }

        const [head] = state.queued

        return state.running === null &&
          head !== undefined &&
          (Predicate.isTagged(ending, "Done") || Predicate.isTagged(ending, "Failed"))
          ? startQueued(head)
          : unchanged
      },
    }),
  )
