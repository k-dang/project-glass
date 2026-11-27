import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { assert, it } from "@effect/vitest"
import { DateTime } from "effect"
import {
  backgroundActivity,
  type BackgroundTasks,
  noBackgroundTasks,
  trackBackgroundTasks,
} from "./claudeBackgroundTasks"

// SAFETY: each message carries only the fields the tracker reads; Claude Code sends many more.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-unsafe-dictionary-type -- See SAFETY above.
const sdk = (fields: Readonly<Record<string, unknown>>) => fields as SDKMessage

const minute = (n: number) => DateTime.makeUnsafe(n * 60_000)

const follow = (...messages: ReadonlyArray<SDKMessage>) =>
  messages.reduce<BackgroundTasks>(
    (tasks, message, index) => trackBackgroundTasks(tasks, message, minute(index)).tasks,
    noBackgroundTasks,
  )

const listed = sdk({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: [
    { task_id: "1", task_type: "local_agent", subagent_type: "Explore", description: "Trace it" },
    { task_id: "2", task_type: "local_agent", subagent_type: "Plan", description: "Plan it" },
    { task_id: "3", task_type: "local_agent", description: "Watch it", ambient: true },
    { task_id: "4", task_type: "local_bash", description: "Serve it" },
    { task_id: "5", task_type: "local_workflow", description: "Ship it" },
  ],
})

const started = sdk({
  type: "system",
  subtype: "task_started",
  task_id: "1",
  tool_use_id: "toolu_1",
  task_type: "local_agent",
  subagent_type: "Explore",
  description: "Trace it",
})

it("lists running background subagents and commands with the tool calls that started them, from when they were first seen", () => {
  assert.deepStrictEqual(backgroundActivity(follow(listed, started)).backgroundTasks, [
    {
      taskId: "1",
      kind: "subagent",
      description: "Explore: Trace it",
      toolCallId: "toolu_1",
      startedAt: minute(0),
    },
    {
      taskId: "2",
      kind: "subagent",
      description: "Plan: Plan it",
      toolCallId: null,
      startedAt: minute(0),
    },
    {
      taskId: "4",
      kind: "command",
      description: "Serve it",
      toolCallId: null,
      startedAt: minute(0),
    },
  ])
})

it("reports the work a notification ends and stops showing it", () => {
  const tracked = trackBackgroundTasks(
    follow(listed, started),
    sdk({ type: "system", subtype: "task_notification", task_id: "1", status: "stopped" }),
    minute(2),
  )

  assert.deepStrictEqual(tracked.ended, {
    work: { kind: "subagent", description: "Explore: Trace it", outcome: "stopped" },
    toolCallId: "toolu_1",
  })
  assert.deepStrictEqual(
    backgroundActivity(tracked.tasks).backgroundTasks.map(({ taskId }) => taskId),
    ["2", "4"],
  )
})
