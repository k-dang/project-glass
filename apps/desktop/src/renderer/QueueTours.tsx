import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { useId } from "react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Backend, backendRuntime } from "./backend"
import { ProblemAlert } from "./ProblemAlert"
import { settledProblem } from "./problems"

const queueToursAtom = Atom.optimistic(
  backendRuntime.atom(Backend.use((backend) => backend.GetQueueTours())),
).pipe(Atom.keepAlive)

const setQueueToursAtom = queueToursAtom.pipe(
  Atom.optimisticFn({
    reducer: (_current, enabled: boolean) => AsyncResult.success(enabled),
    fn: backendRuntime.fn((enabled: boolean) =>
      Backend.use((backend) => backend.SetQueueTours({ enabled })),
    ),
  }),
)

export function QueueToursSetting() {
  const id = useId()
  const result = useAtomValue(queueToursAtom)
  const [saveResult, setEnabled] = useAtom(setQueueToursAtom)
  const reload = useAtomRefresh(queueToursAtom)
  const enabled = Option.getOrNull(AsyncResult.value(result))
  const loadProblem = settledProblem(result)
  const saveProblem = settledProblem(saveResult)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <Switch
          id={id}
          checked={enabled ?? false}
          disabled={enabled === null}
          onCheckedChange={(checked) => setEnabled(checked)}
          aria-describedby={`${id}-description`}
          className="-mt-0.5"
        />
        <div className="flex flex-col gap-1">
          <Label htmlFor={id}>Tours for the Queue</Label>
          <p id={`${id}-description`} className="text-sm text-muted-foreground">
            Automatically write Tours for queued PRs. Turning this off stops any in progress.
          </p>
        </div>
      </div>
      {loadProblem !== null && (
        <ProblemAlert problem={loadProblem} action={{ label: "Try again", run: reload }} />
      )}
      {saveProblem !== null && <ProblemAlert problem={saveProblem} />}
    </div>
  )
}
