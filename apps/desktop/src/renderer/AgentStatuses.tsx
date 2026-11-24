import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type { BackgroundTask } from "@glass/contracts"
import { cn } from "cn"
import { DateTime } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Activity, Bot, Square, Terminal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Elapsed } from "./Elapsed"
import { problemText, settledProblem } from "./problems"
import { threadColumn } from "./threadColumn"
import { stopBackgroundTaskAtom, ThreadBackgroundTask } from "./threadsArea"

function KindIcon(props: { kind: BackgroundTask["kind"] }) {
  const Icon = props.kind === "command" ? Terminal : Bot

  return <Icon aria-hidden className="size-3 shrink-0" />
}

function BackgroundTaskRow(props: { threadId: string; task: BackgroundTask }) {
  const { task } = props

  const atom = stopBackgroundTaskAtom(
    new ThreadBackgroundTask({ threadId: props.threadId, taskId: task.taskId }),
  )

  const stopped = useAtomValue(atom)
  const stop = useAtomSet(atom)
  const stopping = stopped.waiting || AsyncResult.isSuccess(stopped)
  const problem = settledProblem(stopped)

  return (
    <li className="flex flex-col">
      <span className="group flex items-center gap-2 rounded-md py-0.5 pr-1 pl-2 text-muted-foreground hover:bg-muted/50">
        <KindIcon kind={task.kind} />
        <span className="truncate">
          Running a {task.kind}: {task.description}
        </span>
        <Elapsed startedAt={DateTime.toEpochMillis(task.startedAt)} />
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="ml-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-100"
          disabled={stopping}
          aria-label={`${stopping ? "Stopping" : "Stop"} ${task.description}`}
          onClick={() => stop()}
        >
          <Square className="fill-current" />
          {stopping ? "Stopping…" : "Stop"}
        </Button>
      </span>
      {problem !== null && (
        <span role="alert" className="py-0.5 pl-7 text-destructive">
          {problemText(problem)}
        </span>
      )}
    </li>
  )
}

export function AgentStatuses(props: {
  threadId: string
  statuses: ReadonlyArray<string>
  tasks: ReadonlyArray<BackgroundTask>
}) {
  const column = cn(threadColumn, "flex w-full flex-col gap-0.5 px-6 pt-2 text-xs")

  return (
    <>
      {props.statuses.length > 0 && (
        <output aria-label="Agent statuses" className={column}>
          {props.statuses.map((status) => (
            <span
              key={status}
              className="flex items-center gap-2 py-0.5 pl-2 text-muted-foreground"
            >
              <Activity aria-hidden className="size-3 shrink-0" />
              {status}
            </span>
          ))}
        </output>
      )}
      {props.tasks.length > 0 && (
        <ul aria-label="Background tasks" className={column}>
          {props.tasks.map((task) => (
            <BackgroundTaskRow key={task.taskId} threadId={props.threadId} task={task} />
          ))}
        </ul>
      )}
    </>
  )
}
