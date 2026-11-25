import { assert, it } from "@effect/vitest"
import type { TurnEnding } from "@glass/contracts"
import { TurnCutOff, TurnDone, TurnFailed, TurnInterrupted, TurnStopped } from "@glass/contracts"
import {
  type SentQueuedMessage,
  type ThreadState,
  type ThreadStep,
  stepThread,
} from "./threadState"

const sent = (id: string) => ({ id, message: id, images: [], context: null, feedback: [] })

const message = (id: string): SentQueuedMessage => ({ ...sent(id), sentBy: "agent" })

const idle: ThreadState = { running: null, queued: [message("a"), message("b")] }

const busy: ThreadState = { ...idle, running: "turn" }

const unchanged: ThreadStep = { outcome: { type: "unchanged" }, writes: [] }

const startsQueued = (id: string): ThreadStep => ({
  outcome: { type: "started" },
  writes: [
    { type: "dequeue", queuedId: id },
    {
      type: "startTurn",
      message: { ...sent(id), retriesDelivery: false, startedBy: "agent" },
    },
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
      stepThread(idle, { type: "turnEnded", ending, requeued: [] }),
      advances ? startsQueued("a") : unchanged,
      ending._tag,
    )
})

it("starts an idle-only Turn only after the running Turn and all Queued messages", () => {
  const idleOnly = { ...sent("idleOnly"), retriesDelivery: true, startedBy: "glass" as const }

  for (const state of [busy, idle])
    assert.deepStrictEqual(stepThread(state, { type: "startIfIdle", message: idleOnly }), {
      outcome: { type: "busy" },
      writes: [],
    })

  assert.deepStrictEqual(
    stepThread({ running: null, queued: [] }, { type: "startIfIdle", message: idleOnly }),
    {
      outcome: { type: "started" },
      writes: [{ type: "startTurn", message: idleOnly }],
    },
  )
})

it("starts a chosen Queued message only when no Turn is running", () => {
  assert.deepStrictEqual(stepThread(busy, { type: "sendQueued", queuedId: "b" }), {
    outcome: { type: "busy" },
    writes: [],
  })
  assert.deepStrictEqual(stepThread(idle, { type: "sendQueued", queuedId: "b" }), startsQueued("b"))
  assert.deepStrictEqual(stepThread(idle, { type: "sendQueued", queuedId: "x" }), unchanged)
})
