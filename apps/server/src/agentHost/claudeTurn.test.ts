import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { assert, it } from "@effect/vitest"
import { SteerPart, TextPart, TurnDone, type TurnEnding } from "@glass/contracts"
import { DateTime, Predicate } from "effect"
import { beginTurn, Input, step, type TurnState } from "./claudeTurn"

const now = DateTime.makeUnsafe("2026-10-26T12:00:00Z")

const steer = { message: "Use tabs", images: [], id: "steer-1" }

const holding: TurnState = {
  ...beginTurn("turn-1", { message: "Build it", images: [] }, now),
  steers: [steer],
}

// SAFETY: each message carries only the fields the Turn reads; Claude Code sends many more.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-unsafe-dictionary-type -- See SAFETY above.
const sdk = (fields: Readonly<Record<string, unknown>>) => fields as SDKMessage

const runStart = (answered: ReadonlyArray<string>) =>
  sdk({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "message_start" },
    user_message_uuids: answered,
  })

const text = (value: string) => [
  sdk({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  }),
  sdk({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } },
  }),
]

const result = (failed: boolean) =>
  sdk({
    type: "result",
    subtype: "success",
    is_error: failed,
    api_error_status: failed ? 500 : null,
    result: failed ? "overloaded" : "done",
  })

const run = (messages: ReadonlyArray<SDKMessage>, from: TurnState | null = holding) => {
  let state = from
  const events = []

  for (const message of messages) {
    const next = step(state, Input.Message({ message }), now)
    state = next.state
    events.push(...next.events)
  }

  const last = events.at(-1)

  return { state, ending: Predicate.isTagged(last, "TurnEnded") ? last.ended.ending : null }
}

const tag = (ending: TurnEnding | null) => ending?._tag

it("goes on into the run a late Steer starts, showing the Steer where that run takes it in", () => {
  const { state, ending } = run([
    runStart(["prompt-1"]),
    ...text("Built."),
    result(false),
    runStart(["steer-1"]),
    result(false),
  ])

  assert.isNull(state)
  assert.deepStrictEqual(ending, TurnDone.make({}))

  const first = run([runStart(["prompt-1"]), ...text("Built."), result(false)])
  assert.deepStrictEqual(first.state?.turn.parts, [TextPart.make({ text: "Built." })])

  const taken = run([runStart(["steer-1"])], first.state)
  assert.deepStrictEqual(taken.state?.turn.parts, [
    TextPart.make({ text: "Built." }),
    SteerPart.make({ message: steer.message, images: [] }),
  ])
})

it("keeps a failed run's ending when a late Steer's run then succeeds", () => {
  const { ending } = run([
    runStart(["prompt-1"]),
    result(true),
    runStart(["steer-1"]),
    result(false),
  ])

  assert.equal(tag(ending), "Failed")
})

it("ends with the run when Claude Code doesn't stamp its replies, showing the Steers it held", () => {
  const { state, ending } = run([runStart([]), ...text("Built."), result(false)])

  assert.isNull(state)
  assert.deepStrictEqual(ending, TurnDone.make({}))

  const shown = run([runStart([]), ...text("Built.")])
  const ended = step(shown.state, Input.Message({ message: result(false) }), now)
  assert.deepInclude(
    ended.events.flatMap((event) => (Predicate.isTagged(event, "PartSet") ? [event.part] : [])),
    SteerPart.make({ message: steer.message, images: [] }),
  )
})
