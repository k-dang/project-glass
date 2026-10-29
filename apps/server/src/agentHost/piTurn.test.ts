import { assert, it } from "@effect/vitest"
import { SteerPart, TextPart, TurnDone, TurnEnded, TurnFailed, TurnStopped } from "@glass/contracts"
import { DateTime, Predicate } from "effect"
import type { PiEvent } from "./piRpc"
import { beginTurn, Command, Input, leftover, step, stoppedReason, type TurnState } from "./piTurn"

const now = DateTime.makeUnsafe("2026-10-26T12:00:00Z")

const started = beginTurn("turn-1", { message: "Say hello", images: [] }, now)

const run = (inputs: ReadonlyArray<Input | PiEvent>, from: TurnState | null = started) => {
  let state = from
  const events = []
  const commands = []

  for (const input of inputs) {
    const next = step(state, "type" in input ? Input.Event({ event: input }) : input, now)
    state = next.state
    events.push(...next.events)
    commands.push(...next.commands)
  }

  return { state, events, commands }
}

const assistantEnd = (stopReason: string, errorMessage = ""): PiEvent => ({
  type: "message_end",
  message: { role: "assistant", stopReason, errorMessage },
})

it("ends a Turn only when pi is idle after settling, ignoring a stale idle answer", () => {
  const settled = run([{ type: "agent_start" }, { type: "agent_settled" }])

  assert.deepStrictEqual(settled.commands, [Command.CheckIdle({ generation: 1 })])
  assert.isNotNull(settled.state)

  const restarted = run(
    [{ type: "agent_start" }, Input.Idle({ idle: true, generation: 1 })],
    settled.state,
  )

  assert.isNotNull(restarted.state)

  const done = run([Input.Idle({ idle: true, generation: 2 })], restarted.state)
  assert.isNull(done.state)
  assert.deepStrictEqual(
    done.events.at(-1),
    TurnEnded.make({ turnId: "turn-1", ended: { at: now, ending: TurnDone.make({}) } }),
  )
})

it("forgets a provider error once a retry answers", () => {
  const retried = run([
    { type: "agent_start" },
    assistantEnd("error", "overloaded"),
    assistantEnd("stop"),
    { type: "agent_settled" },
    Input.Idle({ idle: true, generation: 1 }),
  ])

  assert.deepInclude(retried.events.at(-1), { ended: { at: now, ending: TurnDone.make({}) } })
})

it("streams text into one part and fails a tool call left running when pi exits", () => {
  const { events, state } = run([
    { type: "agent_start" },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
    },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
    },
    {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "sleep 10" },
    },
    Input.Exited(),
  ])

  assert.isNull(state)
  assert.deepStrictEqual(
    events.map((event) => event._tag),
    ["PartSet", "PartAppended", "PartAppended", "PartSet", "PartSet", "TurnEnded"],
  )
  const failedCall = events[4]
  const part = Predicate.isTagged(failedCall, "PartSet") ? failedCall.part : undefined
  assert.deepInclude(failedCall, { index: 1 })
  assert.equal(Predicate.isTagged(part, "ToolCall") ? part.status : undefined, "failed")
  assert.deepInclude(events.at(-1), {
    ended: { at: now, ending: TurnFailed.make({ reason: stoppedReason }) },
  })

  const text = run([
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
    },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello" },
    },
  ])

  assert.deepStrictEqual(text.state?.turn.parts, [TextPart.make({ text: "Hello" })])
})

it("declines pi's extension dialogs, even between Turns", () => {
  const { commands } = run([{ type: "extension_ui_request", id: "ask-1", method: "confirm" }], null)

  assert.deepStrictEqual(commands, [Command.DeclineDialog({ id: "ask-1" })])
})

it("goes on with the Steers pi went idle holding, showing each as pi takes it in", () => {
  const steer = { message: "Use tabs", images: [], id: "steer-1" }
  const holding = { ...started, steers: [steer] }

  const idle = run(
    [
      { type: "message_start", message: { role: "user" } },
      { type: "agent_start" },
      { type: "agent_settled" },
      Input.Idle({ idle: true, generation: 1 }),
    ],
    holding,
  )

  assert.isNotNull(idle.state)
  assert.deepInclude(idle.commands, Command.Resume({ turnId: "turn-1", steers: [steer] }))

  const resumed = run(
    [{ type: "agent_start" }, { type: "message_start", message: { role: "user" } }],
    idle.state,
  )

  assert.deepStrictEqual(resumed.state?.turn.parts, [
    SteerPart.make({ message: "Use tabs", images: [] }),
  ])
  assert.deepStrictEqual(resumed.state?.steers, [])

  const stopping = run([Input.Idle({ idle: true, generation: 1 })], {
    ...holding,
    generation: 1,
    stopping: true,
  })

  assert.deepInclude(stopping.events.at(-1), { ended: { at: now, ending: TurnStopped.make({}) } })
})

const image = { mediaType: "image/png", data: "AA==" } as const

const tabs = { message: "/tabs", images: [image], id: "steer-2" }

it("gives back the Steers pi held as the user wrote them, and its follow-ups as its text", () => {
  const lint = { message: "Run lint", images: [], id: "steer-1" }

  assert.deepStrictEqual(
    leftover([lint, tabs], {
      steering: ["Use tabs, not spaces"],
      followUp: ["Then run the tests"],
    }),
    [
      { message: "/tabs", images: [image] },
      { message: "Then run the tests", images: [] },
    ],
  )
})

it("gives back an extension's own Steer, queued before the user's, as pi's text", () => {
  assert.deepStrictEqual(
    leftover([tabs], { steering: ["From an extension", "Use tabs, not spaces"], followUp: [] }),
    [
      { message: "/tabs", images: [image] },
      { message: "From an extension", images: [] },
    ],
  )
})
