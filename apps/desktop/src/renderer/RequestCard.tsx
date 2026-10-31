import { useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  AllowRequest,
  AnswerQuestion,
  type AskedQuestion,
  type QuestionReply,
  DenyRequest,
  type RequestAnswer,
  type RequestPart,
} from "@glass/contracts"
import { Match, Predicate } from "effect"
import { CircleCheck, CircleHelp, CircleSlash, CircleX, ShieldAlert } from "lucide-react"
import { type ReactNode, useId, useState } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block"
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationTitle,
} from "@/components/ui/confirmation"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { answerRequestAtom } from "./agentsArea"
import { settledProblem } from "./problems"

/** The element id of a request's card, which the composer points at while it waits. */
export const requestElementId = (requestId: string) => `request-${requestId}`

const useAnswer = (agentId: string, requestId: string) => {
  const answered = useAtomValue(answerRequestAtom(requestId))
  const answer = useAtomSet(answerRequestAtom(requestId))
  const problem = settledProblem(answered)

  return {
    answer: (given: RequestAnswer) => answer({ agentId, answer: given }),
    sending: answered.waiting,
    problem:
      problem === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {problem.detail}
        </p>
      ),
  }
}

const expired = "No longer answerable: its Turn ended."

function Outcome(props: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0">
      {props.icon}
      <span className="min-w-0">{props.children}</span>
    </p>
  )
}

export function RequestCard(props: { agentId: string; part: RequestPart }) {
  const { agentId, part } = props

  return (
    <div id={requestElementId(part.requestId)} className="scroll-mt-4">
      {Predicate.isTagged(part, "Question") ? (
        <Questions agentId={agentId} question={part} />
      ) : (
        <Permission agentId={agentId} request={part} />
      )}
    </div>
  )
}

function Permission(props: {
  agentId: string
  request: Extract<RequestPart, { readonly _tag: "PermissionRequest" }>
}) {
  const { request } = props
  const { answer, sending, problem } = useAnswer(props.agentId, request.requestId)
  const [reason, setReason] = useState("")
  const titleId = useId()
  const reasonId = useId()

  return (
    <Confirmation aria-labelledby={titleId}>
      <ConfirmationTitle id={titleId}>
        <ShieldAlert aria-hidden />
        Allow {request.toolName}?
      </ConfirmationTitle>
      <CodeBlock size="sm">
        <CodeBlockContent wrap className="max-h-64">
          {request.input}
        </CodeBlockContent>
      </CodeBlock>
      {Match.value(request.status).pipe(
        Match.when("waiting", () => (
          <>
            <Label htmlFor={reasonId} className="sr-only">
              Why not? (optional)
            </Label>
            <Input
              id={reasonId}
              placeholder="Why not? Tells the Agent what to do instead (optional)"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <ConfirmationActions>
              <ConfirmationAction
                variant="outline"
                disabled={sending}
                onClick={() =>
                  answer(DenyRequest.make({ reason: reason.trim() === "" ? null : reason.trim() }))
                }
              >
                Deny
              </ConfirmationAction>
              <ConfirmationAction disabled={sending} onClick={() => answer(AllowRequest.make({}))}>
                Allow
              </ConfirmationAction>
            </ConfirmationActions>
            {problem}
          </>
        )),
        Match.when("allowed", () => <Outcome icon={<CircleCheck aria-hidden />}>Allowed</Outcome>),
        Match.when("denied", () => (
          <Outcome icon={<CircleX aria-hidden />}>
            Denied
            {request.reason !== null && `: ${request.reason}`}
          </Outcome>
        )),
        Match.when("expired", () => (
          <Outcome icon={<CircleSlash aria-hidden />}>{expired}</Outcome>
        )),
        Match.exhaustive,
      )}
    </Confirmation>
  )
}

const change = <A,>(list: ReadonlyArray<A>, index: number, value: A) =>
  list.map((current, at) => (at === index ? value : current))

const option = (label: string, description: string | null, control: ReactNode) => (
  <Label key={label} className="flex items-start gap-2 font-normal">
    {control}
    <span className="flex flex-col">
      <span>{label}</span>
      {description !== null && <span className="text-xs text-muted-foreground">{description}</span>}
    </span>
  </Label>
)

function Questions(props: {
  agentId: string
  question: Extract<RequestPart, { readonly _tag: "Question" }>
}) {
  const { question } = props
  const { answer, sending, problem } = useAnswer(props.agentId, question.requestId)

  const [chosen, setChosen] = useState<ReadonlyArray<ReadonlyArray<string>>>(() =>
    question.questions.map(() => []),
  )

  const [typed, setTyped] = useState<ReadonlyArray<string>>(() => question.questions.map(() => ""))
  const titleId = useId()

  // Words the user typed answer a question in place of the options they picked.
  const replies = question.questions.map((_, index): QuestionReply => {
    const text = typed[index]?.trim() ?? ""

    return text === "" ? { chosen: chosen[index] ?? [], text: null } : { chosen: [], text }
  })

  return (
    <Confirmation aria-labelledby={titleId}>
      <ConfirmationTitle id={titleId}>
        <CircleHelp aria-hidden />
        {question.questions.length === 1 ? "The Agent asks" : "The Agent asks you a few things"}
      </ConfirmationTitle>
      {question.questions.map((asked, index) => (
        <QuestionView
          // oxlint-disable-next-line react/no-array-index-key -- A Question's questions never change.
          key={index}
          asked={asked}
          waiting={question.status === "waiting"}
          chosen={chosen[index] ?? []}
          onChoose={(labels) => setChosen((current) => change(current, index, labels))}
          typed={typed[index] ?? ""}
          onType={(text) => setTyped((current) => change(current, index, text))}
          reply={question.answers?.[index] ?? null}
        />
      ))}
      {question.status === "waiting" && (
        <>
          <ConfirmationActions>
            <ConfirmationAction
              disabled={
                sending ||
                replies.some(({ chosen: picked, text }) => picked.length === 0 && text === null)
              }
              onClick={() => answer(AnswerQuestion.make({ answers: replies }))}
            >
              Answer
            </ConfirmationAction>
          </ConfirmationActions>
          {problem}
        </>
      )}
      {question.status === "expired" && (
        <Outcome icon={<CircleSlash aria-hidden />}>{expired}</Outcome>
      )}
    </Confirmation>
  )
}

function QuestionView(props: {
  asked: AskedQuestion
  waiting: boolean
  chosen: ReadonlyArray<string>
  onChoose: (labels: ReadonlyArray<string>) => void
  typed: string
  onType: (text: string) => void
  reply: QuestionReply | null
}) {
  const { asked, reply } = props
  const questionId = useId()
  const textId = useId()
  const textLabel = asked.options.length > 0 ? "Or answer in your own words" : "Your answer"

  return (
    <fieldset aria-labelledby={questionId} className="flex flex-col gap-2">
      <legend id={questionId} className="flex flex-wrap items-baseline gap-2">
        {asked.header !== null && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {asked.header}
          </span>
        )}
        <span>{asked.question}</span>
      </legend>
      {asked.detail !== null && <p className="text-muted-foreground">{asked.detail}</p>}
      {!props.waiting ? (
        reply !== null && (
          <Outcome icon={<CircleCheck aria-hidden />}>
            Answered: {reply.text ?? reply.chosen.join(", ")}
          </Outcome>
        )
      ) : (
        <>
          {asked.options.length > 0 &&
            (asked.multiSelect ? (
              <div className="flex flex-col gap-2">
                {asked.options.map(({ label, description }) =>
                  option(
                    label,
                    description,
                    <Checkbox
                      checked={props.chosen.includes(label)}
                      onCheckedChange={(checked) =>
                        props.onChoose(
                          checked
                            ? [...props.chosen, label]
                            : props.chosen.filter((current) => current !== label),
                        )
                      }
                    />,
                  ),
                )}
              </div>
            ) : (
              <RadioGroup<string | null>
                aria-labelledby={questionId}
                value={props.chosen[0] ?? null}
                onValueChange={(label) => props.onChoose(label === null ? [] : [label])}
              >
                {asked.options.map(({ label, description }) =>
                  option(label, description, <RadioGroupItem value={label} />),
                )}
              </RadioGroup>
            ))}
          {asked.freeText && (
            <>
              <Label htmlFor={textId} className="sr-only">
                {textLabel}
              </Label>
              <Input
                id={textId}
                placeholder={textLabel}
                value={props.typed}
                onChange={(event) => props.onType(event.target.value)}
              />
            </>
          )}
        </>
      )}
    </fieldset>
  )
}
