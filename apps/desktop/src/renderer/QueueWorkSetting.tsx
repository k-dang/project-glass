import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { EngineFeature } from "@glass/contracts"
import { Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { useId } from "react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Backend, backendRuntime } from "./backend"
import { ProblemAlert } from "./ProblemAlert"
import { settledProblem } from "./problems"

const enabledAtoms = Atom.family((feature: EngineFeature) =>
  Atom.optimistic(
    backendRuntime.atom(Backend.use((backend) => backend.GetQueueWork({ feature }))),
  ).pipe(Atom.keepAlive),
)

const setEnabledAtoms = Atom.family((feature: EngineFeature) =>
  enabledAtoms(feature).pipe(
    Atom.optimisticFn({
      reducer: (_current, enabled: boolean) => AsyncResult.success(enabled),
      fn: backendRuntime.fn((enabled: boolean) =>
        Backend.use((backend) => backend.SetQueueWork({ feature, enabled })),
      ),
    }),
  ),
)

const copy = {
  tours: {
    label: "Tours for the Queue",
    description:
      "Automatically write Tours for queued PRs. Turning this off stops any in progress.",
  },
  agentReviews: {
    label: "Agent reviews for the Queue",
    description:
      "Automatically run Agent reviews for queued PRs. Turning this off stops any in progress.",
  },
} satisfies Record<EngineFeature, { label: string; description: string }>

export function QueueWorkSetting(props: { feature: EngineFeature }) {
  const { label, description } = copy[props.feature]
  const enabledAtom = enabledAtoms(props.feature)
  const id = useId()
  const result = useAtomValue(enabledAtom)
  const [saveResult, setEnabled] = useAtom(setEnabledAtoms(props.feature))
  const reload = useAtomRefresh(enabledAtom)
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
          <Label htmlFor={id}>{label}</Label>
          <p id={`${id}-description`} className="text-sm text-muted-foreground">
            {description}
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
