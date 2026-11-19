import { useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  type CheckIn,
  type ConversationNeedsYou,
  type GlobalConversationNeedsYou,
  type NeedsYouItem,
  OutsideChoice,
  type OutsideQuestion,
  type OutsideQuestionAnswer,
  OutsideText,
  type PullRequestNeedsYou,
  referenceKey,
} from "@glass/contracts"
import { Link } from "@tanstack/react-router"
import { cn } from "cn"
import { DateTime, Match } from "effect"
import { Atom } from "effect/reactivity"
import { type ReactNode, useId, useMemo, useState } from "react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { AgentReviewMarkdown } from "./AgentReviewPanel"
import { Backend, backendRuntime } from "./backend"
import { conversationAtoms, ConversationAtomsContext } from "./conversation"
import { ConversationChat, TranscriptProblem } from "./ConversationView"
import { globalConversation, globalConversationOpenAtom } from "./globalConversation"
import {
  contextOf,
  type InboxAction,
  ItemIcon,
  Reasons,
  summaryParts,
  titleOf,
  Waited,
} from "./inboxItem"
import { failingChecksOf, finishedAgentReviewOf } from "./needsYou"
import { settledProblem } from "./problems"
import { ago } from "./PullRequestRow"
import { CheckList } from "./PullRequestStatus"
import { referenceText } from "./queue"
import { RequestCard } from "./RequestCard"

interface DetailProps<Item> {
  readonly item: Item
  readonly now: Date
  readonly actions: ReadonlyArray<InboxAction>
}

export function InboxDetail(
  props: DetailProps<NeedsYouItem> & { onReadReview: (pullRequest: string) => void },
) {
  const { now, actions } = props

  return Match.valueTags(props.item, {
    Conversation: (item) => <ConversationDetail item={item} now={now} actions={actions} />,
    OutsideQuestion: (item) => (
      <OutsideQuestionDetail key={item.id} item={item} now={now} actions={actions} />
    ),
    CheckIn: (item) => <CheckInDetail key={item.id} item={item} now={now} actions={actions} />,
    PullRequest: (item) => (
      <PullRequestDetail
        item={item}
        now={now}
        actions={actions}
        onReadReview={props.onReadReview}
      />
    ),
    GlobalConversation: (item) => (
      <GlobalConversationDetail item={item} now={now} actions={actions} />
    ),
  })
}

// Matches the width of a Conversation's transcript and composer.
const detailWidth = "mx-auto w-full max-w-3xl px-6"

function DetailShell(props: {
  children: ReactNode
  buttons?: ReactNode
  actions: ReadonlyArray<InboxAction>
}) {
  return (
    <article className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className={cn(detailWidth, "flex flex-col gap-6 py-10")}>{props.children}</div>
      </div>
      <DetailFooter buttons={props.buttons} actions={props.actions} />
    </article>
  )
}

function DetailFooter(props: { buttons?: ReactNode; actions: ReadonlyArray<InboxAction> }) {
  return (
    <footer className="border-t">
      <div className={cn(detailWidth, "flex min-h-14 flex-wrap items-center gap-2 py-3")}>
        {props.buttons}
        <p className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {[{ key: "J K", label: "move" }, ...props.actions].map(({ key, label }) => (
            <span key={key} className="inline-flex items-center gap-1">
              <Kbd>{key}</Kbd>
              {label}
            </span>
          ))}
        </p>
      </div>
    </footer>
  )
}

function DetailHeader(props: { item: NeedsYouItem; now: Date; meta?: string }) {
  return (
    <header className="flex items-start gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground">
        <ItemIcon item={props.item} className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-baseline gap-3">
          <h2 className="min-w-0 flex-1 text-xl leading-tight font-semibold text-pretty break-words">
            {titleOf(props.item)}
          </h2>
          <Waited since={props.item.since} now={props.now} />
        </div>
        <p className="flex flex-wrap items-center gap-1.5 text-sm text-pretty text-muted-foreground">
          {props.meta ?? contextOf(props.item)}
          <Reasons item={props.item} />
        </p>
      </div>
    </header>
  )
}

const answerOutsideQuestionAtom = Atom.family((id: string) =>
  backendRuntime.fn((answer: OutsideQuestionAnswer) =>
    Backend.use((backend) => backend.AnswerOutsideQuestion({ id, answer })),
  ),
)

function OutsideQuestionDetail(props: DetailProps<OutsideQuestion>) {
  const { item } = props
  const answering = answerOutsideQuestionAtom(item.id)
  const sent = useAtomValue(answering)
  const answer = useAtomSet(answering)
  const [choice, setChoice] = useState<string | null>(null)
  const [text, setText] = useState("")
  const textId = useId()
  const choicesId = useId()
  const typed = text.trim()
  const problem = settledProblem(sent)
  const textLabel = item.choices.length > 0 ? "Or type an answer" : "Your answer"

  const submit = () => {
    if (typed !== "") answer(OutsideText.make({ text: typed }))
    else if (choice !== null) answer(OutsideChoice.make({ choice }))
  }

  return (
    <DetailShell actions={props.actions}>
      <DetailHeader item={item} now={props.now} />
      <form
        className="flex flex-col gap-4 rounded-xl border bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        {item.choices.length > 0 && (
          <RadioGroup<string | null>
            aria-labelledby={choicesId}
            value={choice}
            onValueChange={setChoice}
          >
            <span id={choicesId} className="sr-only">
              Choices
            </span>
            {item.choices.map((label) => (
              <Label
                key={label}
                className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 font-normal transition-colors duration-150 ease-out hover:bg-muted/50 has-data-checked:border-primary/60 has-data-checked:bg-primary/5"
              >
                <RadioGroupItem value={label} className="mt-px" />
                <span className="min-w-0 text-pretty break-words">{label}</span>
              </Label>
            ))}
          </RadioGroup>
        )}
        <Label htmlFor={textId} className="sr-only">
          {textLabel}
        </Label>
        <Input
          id={textId}
          placeholder={textLabel}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="flex items-center justify-end gap-3">
          <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Kbd>Enter</Kbd>
            sends
          </p>
          <Button type="submit" disabled={sent.waiting || (typed === "" && choice === null)}>
            Send
          </Button>
        </div>
        {problem !== null && (
          <p role="alert" className="text-xs text-destructive">
            {problem.detail}
          </p>
        )}
      </form>
    </DetailShell>
  )
}

function CheckInDetail(props: DetailProps<CheckIn>) {
  const { item } = props
  const details = summaryParts(item.summary)?.details ?? ""

  return (
    <DetailShell
      actions={props.actions}
      buttons={
        <Link
          to="/inbox/check-ins/$checkInId"
          params={{ checkInId: item.id }}
          className={buttonVariants()}
        >
          Read the changes
        </Link>
      }
    >
      <DetailHeader item={item} now={props.now} />
      {details !== "" && (
        <p className="text-sm whitespace-pre-wrap text-pretty break-words">{details}</p>
      )}
    </DetailShell>
  )
}

function ConversationDetail(props: DetailProps<ConversationNeedsYou>) {
  const { conversation } = props.item
  const atoms = useMemo(() => conversationAtoms(conversation.id), [conversation.id])
  const done = props.actions.find(({ key }) => key === "E")

  return (
    <ConversationAtomsContext value={atoms}>
      <article className="flex min-h-0 flex-1 flex-col">
        <div className={cn(detailWidth, "pt-6 pb-2")}>
          <DetailHeader item={props.item} now={props.now} />
        </div>
        <TranscriptProblem />
        <ConversationChat conversation={conversation} place="inbox" />
        <DetailFooter
          actions={props.actions}
          buttons={
            <>
              <Link
                to="/conversations/$conversationId"
                params={{ conversationId: conversation.id }}
                className={buttonVariants({ variant: "outline" })}
              >
                Open the Conversation
              </Link>
              {done === undefined ? null : (
                <Button variant="outline" onClick={done.run}>
                  Done
                </Button>
              )}
            </>
          }
        />
      </article>
    </ConversationAtomsContext>
  )
}

function GlobalConversationDetail(props: DetailProps<GlobalConversationNeedsYou>) {
  const open = useAtomSet(globalConversationOpenAtom)

  return (
    <DetailShell
      actions={props.actions}
      buttons={<Button onClick={() => open(true)}>Open the Global conversation</Button>}
    >
      <DetailHeader item={props.item} now={props.now} />
      <ConversationAtomsContext value={globalConversation}>
        {props.item.requests.map((part) => (
          <RequestCard key={part.requestId} part={part} />
        ))}
      </ConversationAtomsContext>
    </DetailShell>
  )
}

function PullRequestDetail(
  props: DetailProps<PullRequestNeedsYou> & { onReadReview: (pullRequest: string) => void },
) {
  const { pullRequest } = props.item
  const review = finishedAgentReviewOf(props.item)
  const done = props.actions.find(({ key }) => key === "E")
  const updated = DateTime.toDateUtc(pullRequest.updatedAt)

  return (
    <DetailShell
      actions={props.actions}
      buttons={
        <>
          <Link
            to="/reviews/$owner/$repo/$number"
            params={pullRequest.ref}
            className={buttonVariants()}
          >
            Open pull request
          </Link>
          {review === undefined ? null : (
            <Link
              to="/reviews/$owner/$repo/$number"
              params={pullRequest.ref}
              className={buttonVariants({ variant: "outline" })}
              onClick={() => props.onReadReview(referenceKey(pullRequest.ref))}
            >
              Read Agent review
            </Link>
          )}
          {done === undefined ? null : (
            <Button variant="outline" onClick={done.run}>
              Done
            </Button>
          )}
        </>
      }
    >
      <DetailHeader
        item={props.item}
        now={props.now}
        meta={`${referenceText(pullRequest.ref)} · ${pullRequest.author}${pullRequest.isDraft ? " · Draft" : ""} · Updated ${ago(updated, props.now)}`}
      />
      {review === undefined ? null : (
        <section aria-label="Agent review" className="rounded-lg border bg-card px-4 py-3">
          <AgentReviewMarkdown
            markdown={review.lead}
            className="line-clamp-3 text-muted-foreground [&_strong]:text-foreground"
          />
        </section>
      )}
      <FailingChecks item={props.item} />
    </DetailShell>
  )
}

const MAX_FAILING_SHOWN = 3

function FailingChecks(props: { item: PullRequestNeedsYou }) {
  const headingId = useId()
  const failing = failingChecksOf(props.item)

  if (failing.length === 0) return null

  const hidden = failing.length - MAX_FAILING_SHOWN

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1 text-sm">
      <h3 id={headingId} className="text-xs font-medium text-muted-foreground">
        Failing checks
      </h3>
      <CheckList checks={failing.slice(0, MAX_FAILING_SHOWN)} />
      {hidden > 0 && <p className="px-1.5 text-xs text-muted-foreground">and {hidden} more</p>}
    </section>
  )
}
