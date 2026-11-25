import { useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  type CheckIn,
  type InboxThread,
  type InboxGlobalChat,
  type InboxItem,
  type OutsideQuestion,
  type InboxPullRequest,
  referenceKey,
} from "@glass/contracts"
import { Link } from "@tanstack/react-router"
import { cn } from "cn"
import { DateTime, Match } from "effect"
import { Atom } from "effect/reactivity"
import { type ReactNode, useId, useMemo } from "react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { threadColumn } from "./threadColumn"
import { AgentReviewMarkdown } from "./AgentReviewPanel"
import { Backend, backendRuntime } from "./backend"
import { threadAtoms, ThreadAtomsContext } from "./thread"
import { ThreadChat, TranscriptProblem } from "./ThreadView"
import { globalChat, globalChatOpenAtom } from "./globalChat"
import {
  contextOf,
  failingChecksOf,
  finishedAgentReviewOf,
  type InboxAction,
  ItemIcon,
  questionsOf,
  Reasons,
  summaryParts,
  titleOf,
  Waited,
} from "./inboxItem"
import { settledProblem } from "./problems"
import { ago } from "./PullRequestRow"
import { CheckList } from "./PullRequestStatus"
import { referenceText } from "./queue"
import { QuestionsForm } from "./QuestionsForm"
import { RequestCard } from "./RequestCard"

interface DetailProps<Item> {
  readonly item: Item
  readonly now: Date
  readonly actions: ReadonlyArray<InboxAction>
}

export function InboxDetail(
  props: DetailProps<InboxItem> & { onReadReview: (pullRequest: string) => void },
) {
  const { now, actions } = props

  return Match.valueTags(props.item, {
    Thread: (item) => <ThreadDetail item={item} now={now} actions={actions} />,
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
    GlobalChat: (item) => <GlobalChatDetail item={item} now={now} actions={actions} />,
  })
}

const detailWidth = cn(threadColumn, "w-full px-6")

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
          {props.actions.map(({ key, label }) => (
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

function DetailHeader(props: { item: InboxItem; now: Date; meta?: string }) {
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

function OutsideQuestionDetail(props: DetailProps<OutsideQuestion>) {
  const { item } = props

  return (
    <DetailShell actions={props.actions}>
      <DetailHeader item={item} now={props.now} />
      <QuestionsForm asker={`ask:${item.id}`} questions={[item]} />
    </DetailShell>
  )
}

const setCheckInAsideAtom = Atom.family((checkInId: string) =>
  backendRuntime.fn(() => Backend.use((backend) => backend.SetCheckInAside({ checkInId }))),
)

function CheckInDetail(props: DetailProps<CheckIn>) {
  const { item } = props
  const details = summaryParts(item.summary)?.details ?? ""
  const settingAside = useAtomValue(setCheckInAsideAtom(item.id))
  const setAside = useAtomSet(setCheckInAsideAtom(item.id))
  const problem = settledProblem(settingAside)

  return (
    <DetailShell
      actions={props.actions}
      buttons={
        <>
          <Link
            to="/inbox/check-ins/$checkInId"
            params={{ checkInId: item.id }}
            className={buttonVariants()}
          >
            Read the changes
          </Link>
          <Button
            variant="outline"
            disabled={settingAside.waiting}
            onClick={() => setAside(undefined)}
          >
            Set aside
          </Button>
        </>
      }
    >
      <DetailHeader item={item} now={props.now} />
      {details !== "" && (
        <p className="text-sm whitespace-pre-wrap text-pretty break-words">{details}</p>
      )}
      {problem !== null && (
        <p role="alert" className="text-xs text-destructive">
          {problem.detail}
        </p>
      )}
    </DetailShell>
  )
}

function ThreadDetail(props: DetailProps<InboxThread>) {
  const { thread } = props.item
  const atoms = useMemo(() => threadAtoms(thread.id), [thread.id])
  const done = props.actions.find(({ key }) => key === "E")
  const questions = questionsOf(props.item)

  return (
    <ThreadAtomsContext value={atoms}>
      <article className="flex min-h-0 flex-1 flex-col">
        <div className={cn(detailWidth, "flex flex-col gap-4 pt-6 pb-2")}>
          <DetailHeader item={props.item} now={props.now} />
          {questions.length > 0 && (
            <div className="max-h-[50vh] overflow-y-auto">
              <QuestionsForm key={thread.id} asker={`thread:${thread.id}`} questions={questions} />
            </div>
          )}
        </div>
        <TranscriptProblem />
        <ThreadChat thread={thread} place="inbox" />
        <DetailFooter
          actions={props.actions}
          buttons={
            <>
              <Link
                to="/threads/$threadId"
                params={{ threadId: thread.id }}
                className={buttonVariants({ variant: "outline" })}
              >
                Open the Thread
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
    </ThreadAtomsContext>
  )
}

function GlobalChatDetail(props: DetailProps<InboxGlobalChat>) {
  const open = useAtomSet(globalChatOpenAtom)

  return (
    <DetailShell
      actions={props.actions}
      buttons={<Button onClick={() => open(true)}>Open the Global chat</Button>}
    >
      <DetailHeader item={props.item} now={props.now} />
      {props.item.questions.length > 0 && (
        <QuestionsForm asker="global" questions={props.item.questions} />
      )}
      <ThreadAtomsContext value={globalChat}>
        {props.item.requests.map((part) => (
          <RequestCard key={part.requestId} part={part} />
        ))}
      </ThreadAtomsContext>
    </DetailShell>
  )
}

function PullRequestDetail(
  props: DetailProps<InboxPullRequest> & { onReadReview: (pullRequest: string) => void },
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

function FailingChecks(props: { item: InboxPullRequest }) {
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
