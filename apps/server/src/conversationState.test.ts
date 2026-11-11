import { assert, it } from "@effect/vitest"
import type { QueuedMessage, TurnEnding } from "@glass/contracts"
import { TurnCutOff, TurnDone, TurnFailed, TurnInterrupted, TurnStopped } from "@glass/contracts"
import {
  type ConversationState,
  type ConversationStep,
  stepConversation,
} from "./conversationState"

const message = (id: string): QueuedMessage => ({
  id,
  message: id,
  images: [],
  context: null,
  feedback: [],
})

const idle: ConversationState = { running: null, queued: [message("a"), message("b")] }

const busy: ConversationState = { ...idle, running: "turn" }

const unchanged: ConversationStep = { outcome: { type: "unchanged" }, writes: [] }

const startsQueued = (id: string): ConversationStep => ({
  outcome: { type: "started" },
  writes: [
    { type: "dequeue", queuedId: id },
    { type: "startTurn", message: message(id) },
  ],
})

it("advances the queue head only after Done and Failed", () => {
  const endings: ReadonlyArray<readonly [TurnEnding, boolean]> = [
    [TurnDone.make({}), true],
    [TurnFailed.make({ reason: "boom" }), true],
    [TurnStopped.make({}), false],
    [TurnCutOff.make({}), false],
    [TurnInterrupted.make({}), false],
  ]

  for (const [ending, advances] of endings)
    assert.deepStrictEqual(
      stepConversation(idle, { type: "turnEnded", ending }),
      advances ? startsQueued("a") : unchanged,
      ending._tag,
    )
})

it("starts a Turn when idle and queues at the back while running", () => {
  const sent = message("c")

  assert.deepStrictEqual(
    stepConversation({ running: null, queued: [] }, { type: "send", message: sent }),
    { outcome: { type: "started" }, writes: [{ type: "startTurn", message: sent }] },
  )
  assert.deepStrictEqual(stepConversation(busy, { type: "send", message: sent }), {
    outcome: { type: "queued" },
    writes: [{ type: "enqueue", message: sent }],
  })
})

it("starts a chosen Queued message only when no Turn is running", () => {
  assert.deepStrictEqual(stepConversation(busy, { type: "sendQueued", queuedId: "b" }), {
    outcome: { type: "busy" },
    writes: [],
  })
  assert.deepStrictEqual(
    stepConversation(idle, { type: "sendQueued", queuedId: "b" }),
    startsQueued("b"),
  )
  assert.deepStrictEqual(stepConversation(idle, { type: "sendQueued", queuedId: "x" }), unchanged)
})

it("cancels only a message that is still Queued, handing back its feedback", () => {
  assert.deepStrictEqual(stepConversation(busy, { type: "cancelQueued", queuedId: "a" }), {
    outcome: { type: "canceled", feedback: [] },
    writes: [{ type: "dequeue", queuedId: "a" }],
  })
  assert.deepStrictEqual(stepConversation(busy, { type: "cancelQueued", queuedId: "x" }), unchanged)
})
