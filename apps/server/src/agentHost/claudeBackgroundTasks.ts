import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { AgentStatusesChanged, type BackgroundWork } from "@glass/contracts"

interface BackgroundTask {
  readonly kind: BackgroundWork["kind"]
  readonly description: string
  readonly toolCallId: string | null
}

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
  readonly task_type?: string | undefined
  readonly subagent_type?: string | undefined
  readonly description: string
  readonly ambient?: boolean | undefined
}

// Ambient tasks, such as live-update watchers, aren't activity, so Claude Code asks hosts to hide them.
const taskOf = (frame: TaskFrame, toolCallId: string | null): BackgroundTask | null => {
  const kind = kinds.get(frame.task_type ?? "")

  if (kind === undefined || frame.ambient === true) return null

  return {
    kind,
    description:
      kind === "subagent"
        ? `${frame.subagent_type ?? "subagent"}: ${frame.description}`
        : frame.description,
    toolCallId,
  }
}

export interface Tracked {
  readonly tasks: BackgroundTasks
  readonly ended: BackgroundWork | null
}

const unchanged = (tasks: BackgroundTasks): Tracked => ({ tasks, ended: null })

export const trackBackgroundTasks = (tasks: BackgroundTasks, message: SDKMessage): Tracked => {
  if (message.type !== "system") return unchanged(tasks)

  switch (message.subtype) {
    case "task_started": {
      const task = taskOf(message, message.tool_use_id ?? null)

      if (task === null) return unchanged(tasks)

      return {
        tasks: { ...tasks, unendedById: new Map(tasks.unendedById).set(message.task_id, task) },
        ended: null,
      }
    }

    // Claude Code can list a task before its `task_started`, which carries the tool call.
    case "background_tasks_changed": {
      const unendedById = new Map(tasks.unendedById)
      const runningIds: Array<string> = []

      for (const frame of message.tasks) {
        const task = taskOf(frame, tasks.unendedById.get(frame.task_id)?.toolCallId ?? null)

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
        ended: { kind: task.kind, description: task.description, outcome: message.status },
      }
    }

    default:
      return unchanged(tasks)
  }
}

const statusOf = (kind: BackgroundWork["kind"], running: ReadonlyArray<BackgroundTask>) => {
  const descriptions = running.flatMap((task) => (task.kind === kind ? [task.description] : []))

  if (descriptions.length === 0) return []

  const counted = descriptions.length === 1 ? `a ${kind}` : `${descriptions.length} ${kind}s`

  return [`Running ${counted}: ${descriptions.join(", ")}`]
}

export const backgroundActivity = (tasks: BackgroundTasks) => {
  const running = tasks.runningIds.flatMap((id) => tasks.unendedById.get(id) ?? [])

  return AgentStatusesChanged.make({
    agentStatuses: [...statusOf("subagent", running), ...statusOf("command", running)],
    backgroundToolCalls: running.flatMap((task) => task.toolCallId ?? []),
  })
}
