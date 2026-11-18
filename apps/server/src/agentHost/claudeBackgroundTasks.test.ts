import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { assert, it } from "@effect/vitest"
import { AgentStatusesChanged } from "@glass/contracts"
import {
  backgroundActivity,
  type BackgroundTasks,
  noBackgroundTasks,
  trackBackgroundTasks,
} from "./claudeBackgroundTasks"

// SAFETY: each message carries only the fields the tracker reads; Claude Code sends many more.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-unsafe-dictionary-type -- See SAFETY above.
const sdk = (fields: Readonly<Record<string, unknown>>) => fields as SDKMessage

const follow = (...messages: ReadonlyArray<SDKMessage>) =>
  messages.reduce<BackgroundTasks>(
    (tasks, message) => trackBackgroundTasks(tasks, message).tasks,
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

it("words background subagents and commands as Agent statuses, with the tool calls that started them", () => {
  assert.deepStrictEqual(
    backgroundActivity(follow(listed, started)),
    AgentStatusesChanged.make({
      agentStatuses: [
        "Running 2 subagents: Explore: Trace it, Plan: Plan it",
        "Running a command: Serve it",
      ],
      backgroundToolCalls: ["toolu_1"],
    }),
  )
})

it("reports the work a notification ends and stops showing it", () => {
  const tracked = trackBackgroundTasks(
    follow(listed, started),
    sdk({ type: "system", subtype: "task_notification", task_id: "1", status: "failed" }),
  )

  assert.deepStrictEqual(tracked.ended, {
    kind: "subagent",
    description: "Explore: Trace it",
    outcome: "failed",
  })
  assert.deepStrictEqual(backgroundActivity(tracked.tasks).backgroundToolCalls, [])
})
