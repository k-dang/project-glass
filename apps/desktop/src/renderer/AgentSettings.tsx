import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { type EngineFeature, type EngineSettings, ReviewPrompt } from "@glass/contracts"
import { Equal, identity, Schema } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import type { ReactNode } from "react"
import { autosaveSetting } from "./autosaveSetting"
import { Backend } from "./backend"
import { EnginePicker, missingModel } from "./EnginePicker"
import { engineNames } from "./engines"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf, streamProblem } from "./problems"
import { QueueWorkSetting } from "./QueueWorkSetting"
import { ReviewPromptField } from "./ReviewPromptField"
import { SettingsSection } from "./SettingsSection"

const engineAtoms = Atom.family((feature: EngineFeature) =>
  autosaveSetting(
    Backend.use((backend) => backend.GetEngineSettings({ feature })),
    (engineSettings) =>
      Backend.use((backend) => backend.SetEngineSettings({ feature, engineSettings })),
    identity,
  ),
)

const promptAtoms = autosaveSetting(
  Backend.use((backend) => backend.GetReviewPrompt()),
  (prompt) => Backend.use((backend) => backend.SetReviewPrompt({ prompt })),
  (prompt) => prompt.trim(),
)

function useSetting<A>(atoms: ReturnType<typeof autosaveSetting<A>>, saved: A) {
  const [draft, setDraft] = useAtom(atoms.draft)
  const save = useAtomValue(atoms.save)
  const commit = useAtomSet(atoms.commit)
  const value = draft ?? saved

  return {
    value,
    changed: !Equal.equals(atoms.normalize(value), saved),
    change: setDraft,
    commit,
    save,
  }
}

function SettingLoader<A>(props: {
  atoms: ReturnType<typeof autosaveSetting<A>>
  label: string
  children: (saved: A) => ReactNode
}) {
  const saved = useAtomValue(props.atoms.saved)
  const retry = useAtomRefresh(props.atoms.load)

  if (AsyncResult.isSuccess(saved)) return props.children(saved.value)

  return AsyncResult.isFailure(saved) ? (
    <ProblemAlert problem={problemOf(saved.cause)} action={{ label: "Retry", run: retry }} />
  ) : (
    <output>Loading {props.label}…</output>
  )
}

export function AgentSettings() {
  return (
    <>
      <SettingsSection title="Tours" description="Choose when and how Glass writes Tours.">
        <QueueWorkSetting feature="tours" />
        <EngineSetting feature="tours" />
      </SettingsSection>
      <SettingsSection
        title="Agent reviews"
        description="Choose when and how Glass runs Agent reviews. Engine and prompt changes apply to the next Agent review."
      >
        <QueueWorkSetting feature="agentReviews" />
        <EngineSetting feature="agentReviews" />
        <SettingLoader atoms={promptAtoms} label="review prompt">
          {(saved) => <PromptEditor saved={saved} />}
        </SettingLoader>
      </SettingsSection>
    </>
  )
}

function EngineSetting(props: { feature: EngineFeature }) {
  return (
    <SettingLoader atoms={engineAtoms(props.feature)} label="engine settings">
      {(saved) => <EngineEditor feature={props.feature} saved={saved} />}
    </SettingLoader>
  )
}

function EngineEditor(props: { feature: EngineFeature; saved: EngineSettings }) {
  const setting = useSetting(engineAtoms(props.feature), props.saved)
  const name = props.feature === "tours" ? "Tour engine" : "Agent review engine"
  const missing = missingModel(setting.value)
  const invalid = missing ? `The ${engineNames[missing]} ${name} needs a model.` : null

  const commit = (value: EngineSettings) => {
    if (!missingModel(value)) setting.commit(value)
  }

  return (
    <div className="flex flex-col gap-3" aria-busy={setting.save.waiting}>
      <EnginePicker
        legend={name}
        description={
          props.feature === "tours"
            ? "Writes Queue Tours and the Tours you start from a PR."
            : "Runs every Agent review and answers Ask."
        }
        value={setting.value}
        onChange={setting.change}
        onCommit={commit}
      />
      <SaveStatus setting={setting} invalid={invalid} retry={() => commit(setting.value)} />
    </div>
  )
}

const isReviewPrompt = Schema.is(ReviewPrompt)

function PromptEditor(props: { saved: string }) {
  const setting = useSetting(promptAtoms, props.saved)
  const trimmed = setting.value.trim()

  const invalid = isReviewPrompt(trimmed)
    ? null
    : "Write a review prompt. Agent reviews need it to know how you review."

  const commit = (value: string) => {
    if (isReviewPrompt(value.trim())) setting.commit(value)
  }

  return (
    <div className="flex flex-col gap-3" aria-busy={setting.save.waiting}>
      <ReviewPromptField value={setting.value} onChange={setting.change} onCommit={commit} />
      <SaveStatus setting={setting} invalid={invalid} retry={() => commit(setting.value)} />
    </div>
  )
}

function SaveStatus<A>(props: {
  setting: ReturnType<typeof useSetting<A>>
  invalid: string | null
  retry: () => void
}) {
  const save = props.setting.save

  const problem =
    props.setting.changed && AsyncResult.isFailure(save) && !save.waiting
      ? streamProblem(save.cause)
      : null

  const status = save.waiting
    ? "Saving…"
    : (props.invalid ??
      (problem
        ? "Changes weren't saved."
        : props.setting.changed
          ? "Changes save when you leave the field."
          : "Saved automatically."))

  return (
    <>
      <output aria-live="polite" className="text-sm text-muted-foreground">
        {status}
      </output>
      {problem && <ProblemAlert problem={problem} action={{ label: "Retry", run: props.retry }} />}
    </>
  )
}
