import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { AgentStatusesChanged, type BackgroundTask, type BackgroundWork } from "@glass/contracts"
import type { DateTime } from "effect"

export interface BackgroundTasks {
  readonly unendedById: ReadonlyMap<string, BackgroundTask>
  readonly runningIds: ReadonlyArray<string>
}

export const noBackgroundTasks: BackgroundTasks = { unendedById: new Map(), runningIds: [] }

const kinds = new Map<string, BackgroundWork["kind"]>([
  ["local_agent", "subagent"],
  ["local_bash", "command"],
])

interface TaskFrame {
  readonly task_id: string
  readonly task_type?: string | undefined
  readonly subagent_type?: string | undefined
  readonly description: string
  readonly ambient?: boolean | undefined
}

const taskOf = (
  frame: TaskFrame,
  known: BackgroundTask | undefined,
  toolUseId: string | undefined,
  now: DateTime.Utc,
): BackgroundTask | null => {
  const kind = kinds.get(frame.task_type ?? "")

  if (kind === undefined || frame.ambient === true) return null

  return {
    taskId: frame.task_id,
    kind,
    description:
      kind === "subagent"
        ? `${frame.subagent_type ?? "subagent"}: ${frame.description}`
        : frame.description,
    toolCallId: toolUseId ?? known?.toolCallId ?? null,
    startedAt: known?.startedAt ?? now,
  }
}

interface Ended {
  readonly work: BackgroundWork
  readonly toolCallId: string | null
}

interface Tracked {
  readonly tasks: BackgroundTasks
  readonly ended: Ended | null
}

const unchanged = (tasks: BackgroundTasks): Tracked => ({ tasks, ended: null })

export const trackBackgroundTasks = (
  tasks: BackgroundTasks,
  message: SDKMessage,
  now: DateTime.Utc,
): Tracked => {
  if (message.type !== "system") return unchanged(tasks)

  switch (message.subtype) {
    case "task_started": {
      const known = tasks.unendedById.get(message.task_id)
      const task = taskOf(message, known, message.tool_use_id, now)

      if (task === null) return unchanged(tasks)

      return {
        tasks: { ...tasks, unendedById: new Map(tasks.unendedById).set(message.task_id, task) },
        ended: null,
      }
    }

    case "background_tasks_changed": {
      const unendedById = new Map(tasks.unendedById)
      const runningIds: Array<string> = []

      for (const frame of message.tasks) {
        const task = taskOf(frame, tasks.unendedById.get(frame.task_id), undefined, now)

        if (task === null) continue

        unendedById.set(frame.task_id, task)
        runningIds.push(frame.task_id)
      }

      return { tasks: { unendedById, runningIds }, ended: null }
    }

    case "task_notification": {
      const task = tasks.unendedById.get(message.task_id)

      if (task === undefined) return unchanged(tasks)

      const unendedById = new Map(tasks.unendedById)
      unendedById.delete(message.task_id)

      return {
        tasks: {
          unendedById,
          runningIds: tasks.runningIds.filter((id) => id !== message.task_id),
        },
        ended: {
          work: { kind: task.kind, description: task.description, outcome: message.status },
          toolCallId: message.tool_use_id ?? task.toolCallId,
        },
      }
    }

    default:
      return unchanged(tasks)
  }
}

export const backgroundActivity = (tasks: BackgroundTasks) =>
  AgentStatusesChanged.make({
    backgroundTasks: tasks.runningIds.flatMap((id) => tasks.unendedById.get(id) ?? []),
  })
