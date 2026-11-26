import {
  type WorkOutcome,
  type BackgroundWork,
  type PullRequestUpdateReason,
  type Turn,
  type TurnEnd,
  type TurnPart,
  type UpdatedPullRequest,
  referenceText,
} from "@glass/contracts"
import { cn } from "cn"
import { Array as Arr, DateTime, Equivalence, Match, Predicate } from "effect"
import {
  Bot,
  CircleCheck,
  CirclePause,
  CircleStop,
  CircleX,
  LoaderCircle,
  SquareTerminal,
  Unplug,
} from "lucide-react"
import { memo, type ReactNode, useCallback, useContext, useId, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Message, MessageContent, MessageGroup } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import { BackgroundToolCalls, callStatus, toolCallsOf, TurnParts } from "./TurnParts"
import { sentFrom, UserMessage } from "./UserMessage"
import { threadColumn } from "./threadColumn"
import { plural } from "./plural"

export function Transcript(props: {
  turns: ReadonlyArray<Turn>
  earlierTurns: number
  onShowEarlier: (before: string) => void
  status: string | null
  lead?: ReactNode
  latestOnly?: boolean
}) {
  const [revealed, setRevealed] = useState(!props.latestOnly)
  const chains = useMemo(() => chainsOf(props.turns), [props.turns])
  const collapsed = !revealed && (chains.length > 1 || props.earlierTurns > 0)
  const shown = collapsed ? chains.slice(-1) : chains
  const before = props.turns[0]?.id
  const { onShowEarlier } = props

  const showEarlier = useCallback(() => {
    if (before !== undefined) onShowEarlier(before)
  }, [before, onShowEarlier])

  const showEarlierWhenSeen = useCallback(
    (element: HTMLButtonElement | null) => {
      if (element === null || globalThis.IntersectionObserver === undefined) return undefined

      const observer = new IntersectionObserver(([entry]) => {
        if (entry?.isIntersecting) showEarlier()
      })

      observer.observe(element)

      return () => observer.disconnect()
    },
    [showEarlier],
  )

  return (
    <MessageScrollerProvider autoScroll scrollPreviousItemPeek={16}>
      <section aria-label="Transcript" className="flex min-h-0 flex-1 flex-col">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport className="px-6 py-4">
            <MessageScrollerContent className={cn(threadColumn, "w-full")}>
              {props.lead}
              {collapsed ? (
                <div className="text-center">
                  <Button variant="ghost" size="sm" onClick={() => setRevealed(true)}>
                    Show earlier Turns
                  </Button>
                </div>
              ) : (
                props.earlierTurns > 0 && (
                  <div className="text-center">
                    <Button
                      ref={showEarlierWhenSeen}
                      variant="ghost"
                      size="sm"
                      onClick={showEarlier}
                    >
                      Show earlier Turns
                    </Button>
                  </div>
                )
              )}
              {shown.map((chain) => (
                <TurnChain
                  key={chain[0].id}
                  turns={chain}
                  latest={chain === shown.at(-1)}
                  status={chain === shown.at(-1) ? props.status : null}
                />
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </section>
    </MessageScrollerProvider>
  )
}

const outcomeText: Record<WorkOutcome["outcome"], string> = {
  finished: "finished",
  failed: "failed",
  waiting: "is waiting on you",
}

const workOutcomeText = (work: WorkOutcome) => {
  const subject = Match.valueTags(work, {
    Thread: ({ name }) => name,
    AgentReview: ({ pullRequest }) => `Agent review on ${referenceText(pullRequest)}`,
  })

  return `${subject} ${outcomeText[work.outcome]}`
}

function StartedWorkUpdateMessage(props: { work: ReadonlyArray<WorkOutcome> }) {
  return (
    <Message align="end">
      <MessageContent>
        <span className="self-end text-xs text-muted-foreground">Update from Glass</span>
        <ul className="flex flex-col gap-1 self-end text-sm text-muted-foreground">
          {props.work.map((work, index) => (
            <li key={index}>{workOutcomeText(work)}</li>
          ))}
        </ul>
      </MessageContent>
    </Message>
  )
}

const reasonText = (reason: PullRequestUpdateReason) =>
  Match.valueTags(reason, {
    FailingChecks: ({ checks }) => plural(checks.length, "check failed", "checks failed"),
    ReviewFeedback: ({ reviewThreads }) =>
      plural(
        reviewThreads.length,
        "Review thread waits for a reply",
        "Review threads wait for a reply",
      ),
    ChangesRequested: ({ reviewers }) => `${reviewers.join(", ")} requested changes`,
    MergeConflict: () => "a merge conflict",
    Merged: () => "merged",
    Closed: () => "closed",
  })

function PullRequestUpdateMessage(props: { pullRequests: ReadonlyArray<UpdatedPullRequest> }) {
  const id = useId()

  return (
    <Message align="end">
      <MessageContent>
        <span id={id} className="self-end text-xs text-muted-foreground">
          PR update from Glass
        </span>
        <ul
          aria-labelledby={id}
          className="flex flex-col gap-1 self-end text-sm text-muted-foreground"
        >
          {props.pullRequests.map(({ subscriptionId, pullRequest, reasons }) => (
            <li key={subscriptionId}>
              {referenceText(pullRequest)}: {reasons.map(reasonText).join(", ")}
            </li>
          ))}
        </ul>
      </MessageContent>
    </Message>
  )
}

const backgroundKindText: Record<BackgroundWork["kind"], string> = {
  subagent: "Subagent",
  command: "Command",
}

const backgroundOutcomeText: Record<BackgroundWork["outcome"], string> = {
  completed: "finished",
  failed: "failed",
  stopped: "was stopped",
}

const backgroundWorkText = ({ kind, description, outcome }: BackgroundWork) =>
  `${backgroundKindText[kind]} ${description} ${backgroundOutcomeText[outcome]}`

function BackgroundWorkEndedLines(props: { work: ReadonlyArray<BackgroundWork> }) {
  return (
    <Trace>
      {props.work.map((work, index) => (
        <TraceLine key={index} status={work.outcome === "failed" ? "error" : undefined}>
          <TraceIcon>{work.kind === "subagent" ? <Bot /> : <SquareTerminal />}</TraceIcon>
          <TraceTitle className="whitespace-normal">{backgroundWorkText(work)}</TraceTitle>
        </TraceLine>
      ))}
    </Trace>
  )
}

function TurnMessage(props: { turn: Turn }) {
  const { turn } = props

  if (Predicate.isTagged(turn.context, "StartedWorkUpdate"))
    return <StartedWorkUpdateMessage work={turn.context.work} />

  if (Predicate.isTagged(turn.context, "PullRequestUpdate"))
    return <PullRequestUpdateMessage pullRequests={turn.context.pullRequests} />

  if (Predicate.isTagged(turn.context, "BackgroundWorkEnded")) return null

  return (
    <UserMessage
      message={turn.message}
      images={turn.images}
      feedback={turn.feedback}
      label={sentFrom(turn.context)}
    />
  )
}

type Chain = Arr.NonEmptyReadonlyArray<Turn>

const startedOnItsOwn = (turn: Turn) =>
  Predicate.isTagged(turn.context, "BackgroundWorkEnded") ||
  (turn.context === null && turn.message === "" && turn.images.length === 0)

const chainsOf = (turns: ReadonlyArray<Turn>) =>
  turns.reduce<Array<Chain>>((chains, turn) => {
    const last = chains.at(-1)

    if (last !== undefined && startedOnItsOwn(turn)) chains[chains.length - 1] = [...last, turn]
    else chains.push([turn])

    return chains
  }, [])

const sameTurns = Arr.makeEquivalence(Equivalence.strictEqual<Turn>())

function ChainedTurn(props: { turn: Turn; last: boolean }) {
  const { turn } = props

  return (
    <>
      {Predicate.isTagged(turn.context, "BackgroundWorkEnded") && (
        <BackgroundWorkEndedLines work={turn.context.work} />
      )}
      <TurnParts parts={turn.parts} />
      {!props.last && turn.ended !== null && !Predicate.isTagged(turn.ended.ending, "Done") && (
        <Trace>
          <TurnEnding sentAt={turn.sentAt} ended={turn.ended} parts={turn.parts} />
        </Trace>
      )}
    </>
  )
}

const TurnChain = memo(
  function TurnChain(props: { turns: Chain; latest: boolean; status: string | null }) {
    const { turns } = props
    const first = Arr.headNonEmpty(turns)
    const last = Arr.lastNonEmpty(turns)

    return (
      <MessageScrollerItem messageId={first.id} scrollAnchor exactHeight={props.latest}>
        <MessageGroup className="gap-4">
          <TurnMessage turn={first} />
          <Message>
            <MessageContent>
              {turns.map((turn) => (
                <ChainedTurn key={turn.id} turn={turn} last={turn === last} />
              ))}
              <Trace>
                {last.ended === null ? (
                  <TraceLine status="running">
                    <TraceIcon>
                      <LoaderCircle className="animate-spin" />
                    </TraceIcon>
                    <TraceTitle>
                      {props.status === null ? "Working…" : `${props.status}…`}
                    </TraceTitle>
                  </TraceLine>
                ) : (
                  <TurnEnding
                    sentAt={first.sentAt}
                    ended={last.ended}
                    parts={turns.flatMap((turn) => turn.parts)}
                  />
                )}
              </Trace>
            </MessageContent>
          </Message>
        </MessageGroup>
      </MessageScrollerItem>
    )
  },
  (before, after) =>
    before.latest === after.latest &&
    before.status === after.status &&
    sameTurns(before.turns, after.turns),
)

const elapsed = (sentAt: DateTime.Utc, ended: TurnEnd) => {
  const seconds = Math.round(
    (DateTime.toEpochMillis(ended.at) - DateTime.toEpochMillis(sentAt)) / 1000,
  )

  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function TurnEnding(props: {
  sentAt: DateTime.Utc
  ended: TurnEnd
  parts: ReadonlyArray<TurnPart>
}) {
  const inBackground = useContext(BackgroundToolCalls)
  const duration = elapsed(props.sentAt, props.ended)

  const stillRunning = toolCallsOf(props.parts).some(
    (call) => callStatus(call, inBackground) === "background",
  )

  return Match.value(props.ended.ending).pipe(
    Match.tagsExhaustive({
      Done: () =>
        stillRunning ? (
          <TraceLine status="running">
            <TraceIcon>
              <LoaderCircle className="animate-spin" />
            </TraceIcon>
            <TraceTitle>Replied in {duration}, still running in the background…</TraceTitle>
          </TraceLine>
        ) : (
          <TraceLine>
            <TraceIcon>
              <CircleCheck />
            </TraceIcon>
            <TraceTitle>Done in {duration}</TraceTitle>
          </TraceLine>
        ),
      Failed: ({ reason }) => (
        <TraceLine status="error" role="alert" className="items-start">
          <TraceIcon className="mt-0.5">
            <CircleX />
          </TraceIcon>
          <span className="min-w-0 whitespace-normal">
            Failed after {duration}: {reason}
          </span>
        </TraceLine>
      ),
      Stopped: () => (
        <TraceLine>
          <TraceIcon>
            <CircleStop />
          </TraceIcon>
          <TraceTitle>Stopped after {duration}</TraceTitle>
        </TraceLine>
      ),
      CutOff: () => (
        <TraceLine status="error">
          <TraceIcon>
            <Unplug />
          </TraceIcon>
          <TraceTitle>Cut off after {duration} when Glass lost the Thread</TraceTitle>
        </TraceLine>
      ),
      Interrupted: () => (
        <TraceLine>
          <TraceIcon>
            <CirclePause />
          </TraceIcon>
          <TraceTitle>Interrupted when Glass quit</TraceTitle>
        </TraceLine>
      ),
    }),
  )
}
