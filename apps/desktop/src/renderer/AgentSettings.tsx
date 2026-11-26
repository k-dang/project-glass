import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  defaultPullRequestUpdateNote,
  defaultReviewPrompt,
  type EngineFeature,
  type EngineSettings,
  PullRequestUpdateNote,
  ReviewPrompt,
} from "@glass/contracts"
import { Equal, identity, Schema } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import type { ReactNode } from "react"
import { autosaveSetting } from "./autosaveSetting"
import { Backend } from "./backend"
import { EnginePicker, missingModel } from "./EnginePicker"
import { harnessNames } from "./harnesses"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf, streamProblem } from "./problems"
import { QueueWorkSetting } from "./QueueWorkSetting"
import { SettingsSection } from "./SettingsSection"
import { type TextSettingCopy, TextSettingField } from "./TextSettingField"

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

const noteAtoms = autosaveSetting(
  Backend.use((backend) => backend.GetPullRequestUpdateNote()),
  (note) => Backend.use((backend) => backend.SetPullRequestUpdateNote({ note })),
  (note) => note.trim(),
)

interface TextSetting {
  readonly atoms: ReturnType<typeof autosaveSetting<string>>
  readonly copy: TextSettingCopy
  readonly isValid: (text: string) => boolean
  readonly invalid: string
}

const reviewPrompt: TextSetting = {
  atoms: promptAtoms,
  isValid: Schema.is(ReviewPrompt),
  invalid: "Write a review prompt. Agent reviews need it to know how you review.",
  copy: {
    title: "Review prompt",
    description: "How you review: what to look for and what to skip.",
    footnote: "Glass wraps it in its own instructions, which fix the answer format.",
    defaultValue: defaultReviewPrompt,
  },
}

const pullRequestUpdateNote: TextSetting = {
  atoms: noteAtoms,
  isValid: Schema.is(PullRequestUpdateNote),
  invalid: "Write a PR update note. Threads need it to know how you handle PRs.",
  copy: {
    title: "PR update note",
    description: "How a Thread handles a PR: what to fix, what to leave, and what never to do.",
    footnote:
      "Glass gives it to the agent with every PR update, beside the note the agent left with its Subscription.",
    defaultValue: defaultPullRequestUpdateNote,
  },
}

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
          {(saved) => <TextSettingEditor setting={reviewPrompt} saved={saved} separated />}
        </SettingLoader>
      </SettingsSection>
      <SettingsSection
        title="PR updates"
        description="Choose how Threads handle the PRs they have a Subscription to. Changes apply to the next PR update."
      >
        <SettingLoader atoms={noteAtoms} label="PR update note">
          {(saved) => <TextSettingEditor setting={pullRequestUpdateNote} saved={saved} />}
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
  const invalid = missing ? `The ${harnessNames[missing]} ${name} needs a model.` : null

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
      <SettingProblems setting={setting} invalid={invalid} retry={() => commit(setting.value)} />
    </div>
  )
}

function TextSettingEditor(props: { setting: TextSetting; saved: string; separated?: boolean }) {
  const { atoms, copy, isValid, invalid } = props.setting
  const setting = useSetting(atoms, props.saved)

  const commit = (value: string) => {
    if (isValid(value.trim())) setting.commit(value)
  }

  return (
    <div className="flex flex-col gap-3" aria-busy={setting.save.waiting}>
      <TextSettingField
        copy={copy}
        value={setting.value}
        separated={props.separated}
        onChange={setting.change}
        onCommit={commit}
      />
      <SettingProblems
        setting={setting}
        invalid={isValid(setting.value.trim()) ? null : invalid}
        retry={() => commit(setting.value)}
      />
    </div>
  )
}

function SettingProblems<A>(props: {
  setting: ReturnType<typeof useSetting<A>>
  invalid: string | null
  retry: () => void
}) {
  const save = props.setting.save

  const problem =
    props.setting.changed && AsyncResult.isFailure(save) && !save.waiting
      ? streamProblem(save.cause)
      : null

  return (
    <>
      {props.invalid && <p className="text-sm text-muted-foreground">{props.invalid}</p>}
      {problem && <ProblemAlert problem={problem} action={{ label: "Retry", run: props.retry }} />}
    </>
  )
}
