import {
  PartAppended,
  PartSet,
  TextPart,
  ThinkingPart,
  ToolCallPart,
  TurnDone,
  TurnEnded,
  TurnStarted,
} from "@glass/contracts"
import { DateTime, Effect } from "effect"
import { Journal, JournalBudget } from "../src/agentHost/Journal"
import type { HostEvent } from "../src/agentHost/protocol"
import { toolOutput } from "../src/agentHost/toolCalls"

const DELTA_CHARS = 13

const STEPS_PER_HOUR = 240

const usualOutput = (step: number) => (step % 20 === 0 ? 120_000 : step % 4 === 0 ? 10_000 : 1_000)

const cappedOutput = () => 120_000

const text = (chars: number, seed: number) =>
  Array.from({ length: chars }, (_, index) => String.fromCharCode(97 + ((seed + index) % 26))).join(
    "",
  )

function* hourOfWork(
  agentId: string,
  hour: number,
  outputChars: (step: number) => number = usualOutput,
): Generator<HostEvent> {
  const at = DateTime.makeUnsafe("2026-11-15T00:00:00Z")
  const turnId = `${agentId}-turn-${hour}`
  yield TurnStarted.make({
    turnId,
    message: "Keep going",
    images: [],
    context: null,
    feedback: [],
    sentAt: at,
  })
  let index = 0

  for (let step = 0; step < STEPS_PER_HOUR; step++) {
    for (const [make, chars] of [
      [ThinkingPart, 800],
      [TextPart, 400],
    ] as const) {
      const part = index++
      yield PartSet.make({ turnId, index: part, part: make.make({ text: "" }) })

      for (let sent = 0; sent < chars; sent += DELTA_CHARS)
        yield PartAppended.make({ turnId, index: part, text: text(DELTA_CHARS, step + sent) })
    }

    const call = ToolCallPart.make({
      toolCallId: `${turnId}-call-${step}`,
      name: "Bash",
      inputSummary: "pnpm test",
      input: text(300, step),
      output: null,
      status: "running",
      parentToolCallId: null,
    })

    const part = index++
    yield PartSet.make({ turnId, index: part, part: call })
    yield PartSet.make({
      turnId,
      index: part,
      part: { ...call, status: "done", output: toolOutput(text(outputChars(step), step)) },
    })
  }

  yield TurnEnded.make({ turnId, ended: { at, ending: TurnDone.make({}) } })
}

const heap = () => {
  globalThis.gc?.()
  globalThis.gc?.()

  return process.memoryUsage().heapUsed
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

const program = Effect.gen(function* () {
  const journal = yield* Journal
  const budget = yield* JournalBudget
  const before = heap()
  let entries = 0
  let json = 0
  let hours = 0

  while (!(yield* journal.full)) {
    for (const event of hourOfWork("agent-1", hours)) {
      yield* journal.append("agent-1", event)
      entries++
      json += JSON.stringify(event).length
    }

    hours++

    if (hours === 1)
      console.log(
        `One Agent-hour: ${entries} entries, ${mb(json)} as JSON, ${mb(heap() - before)} of heap`,
      )
  }

  const retained = heap() - before

  const cappedJson = Array.from(hourOfWork("agent-2", 0, cappedOutput)).reduce(
    (total, event) => total + JSON.stringify(event).length,
    0,
  )

  console.log(
    `With every tool output cut short at 100,000 characters: ${mb(cappedJson)} as JSON an Agent-hour`,
  )
  console.log(
    `Budget of ${mb(budget)} filled after ${hours} Agent-hours: ${entries} entries, ${mb(json)} as JSON, ${mb(retained)} of heap (${(retained / json).toFixed(2)} heap bytes per JSON byte)`,
  )
})

if (globalThis.gc === undefined) throw new Error("Run with node --expose-gc")

void Effect.runPromise(program.pipe(Effect.provide(Journal.layer)))
