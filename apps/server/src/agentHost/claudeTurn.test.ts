import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { assert, it } from "@effect/vitest"
import {
  SteerPart,
  TextPart,
  ThinkingPart,
  TurnDone,
  type TurnEnding,
  TurnFailed,
  type TurnPart,
} from "@glass/contracts"
import { DateTime, Predicate } from "effect"
import type { ToolInput } from "./toolCalls"
import { beginTurn, Input, step, stoppedReason, type TurnState } from "./claudeTurn"

const now = DateTime.makeUnsafe("2026-10-26T12:00:00Z")

const steer = { message: "Use tabs", images: [], id: "steer-1" }

const fresh = beginTurn("turn-1", { message: "Build it", images: [] }, now)

const holding: TurnState = { ...fresh, steers: [steer] }

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

it("ends a Turn the user stopped as stopped, however Claude Code finishes it", () => {
  assert.equal(
    tag(run([runStart([]), result(true)], { ...fresh, stopping: true }).ending),
    "Stopped",
  )
})

it("fails the running Turn when Claude Code exits", () => {
  const exited = step(fresh, Input.Exited(), now)

  const last = exited.events.at(-1)

  assert.isNull(exited.state)
  assert.deepStrictEqual(
    Predicate.isTagged(last, "TurnEnded") ? last.ended.ending : null,
    TurnFailed.make({ reason: stoppedReason }),
  )
})

const thinking = (value: string) => [
  sdk({
    type: "stream_event",
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    },
  }),
  sdk({
    type: "stream_event",
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: value },
    },
  }),
]

const toolUse = (id: string, name: string, input: ToolInput, parent: string | null = null) =>
  sdk({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", id, name, input }] },
  })

const toolResult = (
  id: string,
  content: string | ReadonlyArray<{ readonly type: "text"; readonly text: string }>,
  isError = false,
) =>
  sdk({
    type: "user",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
  })

const shown = (part: TurnPart) =>
  Predicate.isTagged(part, "ToolCall")
    ? {
        name: part.name,
        summary: part.inputSummary,
        output: part.output,
        status: part.status,
        parent: part.parentToolCallId,
      }
    : part

it("streams thinking, text, and tool calls, nesting a subagent's under its parent", () => {
  const { state, ending } = run(
    [
      runStart([]),
      ...thinking("I'll delegate the listing."),
      toolUse("task-1", "Agent", { description: "List files", prompt: "Run ls" }),
      sdk({
        type: "stream_event",
        parent_tool_use_id: "task-1",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "The subagent's own words" },
        },
      }),
      toolUse("bash-1", "Bash", { command: "ls" }, "task-1"),
      toolResult("bash-1", "README.md"),
      toolResult("task-1", [{ type: "text", text: "README.md" }]),
      toolUse("bash-2", "Bash", { command: "false" }),
      toolResult("bash-2", "exit 1", true),
      runStart([]),
      ...text("There's a **README**."),
    ],
    fresh,
  )

  assert.isNull(ending)
  assert.deepStrictEqual(state?.turn.parts.map(shown), [
    ThinkingPart.make({ text: "I'll delegate the listing." }),
    { name: "Agent", summary: "List files", output: "README.md", status: "done", parent: null },
    { name: "Bash", summary: "ls", output: "README.md", status: "done", parent: "task-1" },
    { name: "Bash", summary: "false", output: "exit 1", status: "failed", parent: null },
    TextPart.make({ text: "There's a **README**." }),
  ])
})

it("fails a Turn Claude Code couldn't sign in for, leaving out Claude Code's own words", () => {
  const { ending } = run(
    [
      sdk({
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 401,
        result: "sk-ant-secret is not a valid API key",
      }),
    ],
    fresh,
  )

  const reason = Predicate.isTagged(ending, "Failed") ? ending.reason : ""
  assert.include(reason, "sign in")
  assert.notInclude(reason, "sk-ant-secret")
})
