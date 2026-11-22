import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { EngineFeature } from "@glass/contracts"
import { Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Backend, backendRuntime } from "./backend"
import { ProblemAlert } from "./ProblemAlert"
import { settledProblem } from "./problems"
import { SwitchSetting } from "./SwitchSetting"

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
  const result = useAtomValue(enabledAtom)
  const [saveResult, setEnabled] = useAtom(setEnabledAtoms(props.feature))
  const reload = useAtomRefresh(enabledAtom)
  const enabled = Option.getOrNull(AsyncResult.value(result))
  const loadProblem = settledProblem(result)
  const saveProblem = settledProblem(saveResult)

  return (
    <div className="flex flex-col gap-3">
      <SwitchSetting
        label={label}
        description={description}
        checked={enabled ?? false}
        disabled={enabled === null}
        onCheckedChange={setEnabled}
      />
      {loadProblem !== null && (
        <ProblemAlert problem={loadProblem} action={{ label: "Try again", run: reload }} />
      )}
      {saveProblem !== null && <ProblemAlert problem={saveProblem} />}
    </div>
  )
}
