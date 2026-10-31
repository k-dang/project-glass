import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { type EngineSettings, ReviewPrompt } from "@glass/contracts"
import { Effect, Equal, Exit, Option, Schema } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { cn } from "cn"
import { type ReactNode, useState } from "react"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"
import { Backend, backendRuntime } from "./backend"
import { EnginePicker, missingModel } from "./EnginePicker"
import { engineNames } from "./engines"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf, settledProblem } from "./problems"
import { QueueToursSetting } from "./QueueTours"
import { ReviewPromptField } from "./ReviewPromptField"
import { SettingsSection } from "./SettingsSection"

interface AgentSettings {
  readonly tours: EngineSettings
  readonly agentReviews: EngineSettings
  readonly reviewPrompt: string
}

const loadAtom = backendRuntime
  .atom(
    Backend.use((backend) =>
      Effect.all(
        {
          tours: backend.GetEngineSettings({ feature: "tours" }),
          agentReviews: backend.GetEngineSettings({ feature: "agentReviews" }),
          reviewPrompt: backend.GetReviewPrompt(),
        },
        { concurrency: "unbounded" },
      ),
    ),
  )
  .pipe(Atom.keepAlive)

const ifChanged = <A, E, R>(draft: A, saved: A, write: (value: A) => Effect.Effect<A, E, R>) =>
  Equal.equals(draft, saved) ? Effect.succeed(saved) : write(draft)

const saveAtom = backendRuntime
  .fn(({ saved, draft }: { saved: AgentSettings; draft: AgentSettings }, get) =>
    Backend.use((backend) =>
      Effect.all(
        {
          tours: ifChanged(draft.tours, saved.tours, (engineSettings) =>
            backend.SetEngineSettings({ feature: "tours", engineSettings }),
          ),
          agentReviews: ifChanged(draft.agentReviews, saved.agentReviews, (engineSettings) =>
            backend.SetEngineSettings({ feature: "agentReviews", engineSettings }),
          ),
          reviewPrompt: ifChanged(draft.reviewPrompt, saved.reviewPrompt, (prompt) =>
            backend.SetReviewPrompt({ prompt }),
          ),
        },
        { concurrency: "unbounded" },
      ),
    ).pipe(
      Effect.onError(() =>
        Effect.suspend(() => {
          get.refresh(loadAtom)

          return get.result(loadAtom, { suspendOnWaiting: true })
        }).pipe(Effect.ignore),
      ),
    ),
  )
  .pipe(Atom.keepAlive)

const savedAtom = Atom.make((get) => {
  const save = get(saveAtom)

  return AsyncResult.isSuccess(save) ? save : get(loadAtom)
})

const isReviewPrompt = Schema.is(ReviewPrompt)

export function AgentSettings() {
  const saved = useAtomValue(savedAtom)
  const retry = useAtomRefresh(loadAtom)

  return Option.match(AsyncResult.value(saved), {
    onSome: (settings) => <AgentSettingsEditor saved={settings} />,
    onNone: () => (
      <ToursSection>
        {AsyncResult.isFailure(saved) ? (
          <ProblemAlert problem={problemOf(saved.cause)} action={{ label: "Retry", run: retry }} />
        ) : (
          <output>Loading Tour and Agent review settings…</output>
        )}
      </ToursSection>
    ),
  })
}

function AgentSettingsEditor(props: { saved: AgentSettings }) {
  const [draft, setDraft] = useState(props.saved)
  const [save, setSave] = useAtom(saveAtom, { mode: "promiseExit" })
  const trimmed = { ...draft, reviewPrompt: draft.reviewPrompt.trim() }
  const unchanged = Equal.equals(trimmed, props.saved)
  const problem = settledProblem(save)
  const change = (changed: Partial<AgentSettings>) => setDraft({ ...draft, ...changed })

  const missingTourModel = missingModel(draft.tours)
  const missingReviewModel = missingModel(draft.agentReviews)

  const invalid = missingTourModel
    ? `The ${engineNames[missingTourModel]} Tour engine needs a model.`
    : missingReviewModel
      ? `The ${engineNames[missingReviewModel]} Agent review engine needs a model.`
      : !isReviewPrompt(trimmed.reviewPrompt)
        ? "Write a review prompt. Agent reviews need it to know how you review."
        : null

  const status = save.waiting ? "Saving…" : (invalid ?? (unchanged ? "" : "Unsaved changes."))

  return (
    <form
      aria-busy={save.waiting}
      className="flex flex-col gap-8"
      onSubmit={async (event) => {
        event.preventDefault()
        setDraft(trimmed)
        const result = await setSave({ saved: props.saved, draft: trimmed })

        if (Exit.isSuccess(result)) {
          toast.add({ type: "success", title: "Settings saved.", timeout: 2500 })
        }
      }}
    >
      <fieldset disabled={save.waiting} className="contents">
        <ToursSection>
          <EnginePicker
            legend="Tour engine"
            description="Writes Queue Tours and the Tours you start from a PR."
            value={draft.tours}
            onChange={(tours) => change({ tours })}
          />
        </ToursSection>
        <SettingsSection
          title="Agent reviews"
          description="Choose which engine runs Agent reviews and how you review. Changes apply to the next Agent review."
        >
          <EnginePicker
            legend="Agent review engine"
            description="Runs every Agent review and answers Ask."
            value={draft.agentReviews}
            onChange={(agentReviews) => change({ agentReviews })}
          />
          <ReviewPromptField
            value={draft.reviewPrompt}
            onChange={(reviewPrompt) => change({ reviewPrompt })}
          />
        </SettingsSection>
        {problem !== null && <ProblemAlert problem={problem} />}
        <div
          className={cn(
            "sticky bottom-4 z-10 flex items-center gap-3 self-end rounded-xl border bg-card p-1.5",
            (!unchanged || save.waiting) && "shadow-lg",
          )}
        >
          <output
            aria-live="polite"
            className={status ? "pl-2.5 text-sm text-muted-foreground" : "sr-only"}
          >
            {status}
          </output>
          <Button
            type="button"
            variant="ghost"
            disabled={unchanged}
            onClick={() => setDraft(props.saved)}
          >
            Discard
          </Button>
          <Button type="submit" className="min-w-28" disabled={unchanged || invalid !== null}>
            {save.waiting ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}

function ToursSection(props: { children: ReactNode }) {
  return (
    <SettingsSection title="Tours" description="Choose when and how Glass writes Tours.">
      <QueueToursSetting />
      {props.children}
    </SettingsSection>
  )
}
