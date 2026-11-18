import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { AgentStatusesChanged, type BackgroundWork } from "@glass/contracts"

interface BackgroundTask {
  readonly kind: BackgroundWork["kind"]
  readonly description: string
  readonly toolCallId: string | null
}

export interface BackgroundTasks {
  /** Every task Claude Code told of and hasn't reported ending, by task id. */
  readonly known: ReadonlyMap<string, BackgroundTask>
  /** The ids of the tasks running in the background, in Claude Code's order. */
  readonly running: ReadonlyArray<string>
}

export const noBackgroundTasks: BackgroundTasks = { known: new Map(), running: [] }

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

/** Follows Claude Code's background tasks through one message, with the work it shows ending. */
export const trackBackgroundTasks = (tasks: BackgroundTasks, message: SDKMessage): Tracked => {
  if (message.type !== "system") return unchanged(tasks)

  switch (message.subtype) {
    case "task_started": {
      const task = taskOf(message, message.tool_use_id ?? null)

      if (task === null) return unchanged(tasks)

      return {
        tasks: { ...tasks, known: new Map(tasks.known).set(message.task_id, task) },
        ended: null,
      }
    }

    // Claude Code can list a task before its `task_started`, which carries the tool call.
    case "background_tasks_changed": {
      const known = new Map(tasks.known)
      const running: Array<string> = []

      for (const frame of message.tasks) {
        const task = taskOf(frame, tasks.known.get(frame.task_id)?.toolCallId ?? null)

        if (task === null) continue

        known.set(frame.task_id, task)
        running.push(frame.task_id)
      }

      return { tasks: { known, running }, ended: null }
    }

    case "task_notification": {
      const task = tasks.known.get(message.task_id)

      if (task === undefined) return unchanged(tasks)

      const known = new Map(tasks.known)
      known.delete(message.task_id)

      return {
        tasks: { known, running: tasks.running.filter((id) => id !== message.task_id) },
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

/** The Agent statuses and running tool calls that show Claude Code's background tasks. */
export const backgroundActivity = (tasks: BackgroundTasks) => {
  const running = tasks.running.flatMap((id) => tasks.known.get(id) ?? [])

  return AgentStatusesChanged.make({
    agentStatuses: [...statusOf("subagent", running), ...statusOf("command", running)],
    backgroundToolCalls: running.flatMap((task) => task.toolCallId ?? []),
  })
}
