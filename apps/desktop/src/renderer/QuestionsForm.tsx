import { useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  ChoiceAnswer,
  type GivenAnswer,
  type OpenQuestion,
  type QuestionAnswer,
  TextAnswer,
} from "@glass/contracts"
import { Array as Arr, Exit } from "effect"
import { Atom } from "effect/reactivity"
import { useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Backend, backendRuntime } from "./backend"
import { option } from "./RequestCard"
import { settledProblem } from "./problems"

const answerQuestionsAtom = Atom.family((_asker: string) =>
  backendRuntime.fn((answers: Arr.NonEmptyReadonlyArray<GivenAnswer>) =>
    Backend.use((backend) => backend.AnswerQuestions({ answers })),
  ),
)

const setQuestionAsideAtom = Atom.family((_asker: string) =>
  backendRuntime.fn((questionId: string) =>
    Backend.use((backend) => backend.SetQuestionAside({ questionId })),
  ),
)

interface Draft {
  readonly choice: string | null
  readonly text: string
}

const emptyDraft: Draft = { choice: null, text: "" }

const answerOf = ({ choice, text }: Draft): QuestionAnswer | null => {
  const typed = text.trim()

  if (typed !== "") return TextAnswer.make({ text: typed })

  return choice === null ? null : ChoiceAnswer.make({ choice })
}

export function QuestionsForm(props: { asker: string; questions: ReadonlyArray<OpenQuestion> }) {
  const sent = useAtomValue(answerQuestionsAtom(props.asker))
  const send = useAtomSet(answerQuestionsAtom(props.asker), { mode: "promiseExit" })
  const settingAside = useAtomValue(setQuestionAsideAtom(props.asker))
  const setAside = useAtomSet(setQuestionAsideAtom(props.asker))
  const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(new Map())
  const problem = settledProblem(sent) ?? settledProblem(settingAside)

  const answers = props.questions.flatMap(({ id }): ReadonlyArray<GivenAnswer> => {
    const answer = answerOf(drafts.get(id) ?? emptyDraft)

    return answer === null ? [] : [{ questionId: id, answer }]
  })

  const draft = (id: string, change: (draft: Draft) => Draft) =>
    setDrafts((current) => new Map(current).set(id, change(current.get(id) ?? emptyDraft)))

  const submit = () => {
    if (!Arr.isReadonlyArrayNonEmpty(answers)) return

    void send(answers).then((exit) => {
      if (Exit.isFailure(exit)) return

      setDrafts((current) => {
        const next = new Map(current)

        for (const { questionId } of answers) next.delete(questionId)

        return next
      })
    })
  }

  return (
    <form
      className="flex flex-col gap-4 rounded-xl border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {props.questions.map((question) => (
        <QuestionFields
          key={question.id}
          question={question}
          draft={drafts.get(question.id) ?? emptyDraft}
          titled={props.questions.length > 1}
          onDraft={(change) => draft(question.id, change)}
          onSetAside={() => setAside(question.id)}
          settingAside={settingAside.waiting}
        />
      ))}
      <div className="flex items-center justify-end gap-3">
        <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Kbd>Enter</Kbd>
          sends
        </p>
        <Button type="submit" disabled={sent.waiting || answers.length === 0}>
          Send answers
        </Button>
      </div>
      {problem !== null && (
        <p role="alert" className="text-xs text-destructive">
          {problem.detail}
        </p>
      )}
    </form>
  )
}

function QuestionFields(props: {
  question: OpenQuestion
  draft: Draft
  titled: boolean
  onDraft: (change: (draft: Draft) => Draft) => void
  onSetAside: () => void
  settingAside: boolean
}) {
  const { question, draft } = props
  const legendId = useId()
  const textId = useId()
  const textLabel = question.choices.length > 0 ? "Or answer in your own words" : "Your answer"

  return (
    <fieldset aria-labelledby={legendId} className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <legend
          id={legendId}
          className={
            props.titled ? "min-w-0 flex-1 text-sm font-medium text-pretty break-words" : "sr-only"
          }
        >
          {question.question}
        </legend>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={props.settingAside}
          onClick={props.onSetAside}
        >
          Set aside
        </Button>
      </div>
      {question.choices.length > 0 && (
        <RadioGroup<string | null>
          aria-label="Choices"
          className="gap-3"
          value={draft.choice}
          onValueChange={(choice) => props.onDraft((current) => ({ ...current, choice }))}
        >
          {question.choices.map(({ label, description }) =>
            option(label, description, <RadioGroupItem value={label} />),
          )}
        </RadioGroup>
      )}
      <Label htmlFor={textId} className="sr-only">
        {textLabel}
      </Label>
      <Input
        id={textId}
        placeholder={textLabel}
        value={draft.text}
        onChange={(event) => {
          const text = event.target.value

          props.onDraft((current) => ({ ...current, text }))
        }}
      />
    </fieldset>
  )
}
