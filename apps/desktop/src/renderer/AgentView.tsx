import {
  RegistryContext,
  useAtom,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react"
import {
  type Agent,
  emptyTranscript,
  asksPermission,
  type CapturedContext,
  type ReportedWork,
  type FeedbackNote,
  type Image,
  isNothingUnsent,
  isWaiting,
  nothingUnsent,
  type QueuedMessage,
  repositoryKey,
  type RequestPart,
  type SentMessage,
  sentOf,
  type ToolCallPart,
  type Turn,
  type TurnEnd,
  type TurnPart,
  goneExplanation,
  isGone,
  shortSha,
} from "@glass/contracts"
import { cn } from "cn"
import { DateTime, Exit, Match, Option, Predicate } from "effect"
import { AsyncResult } from "effect/reactivity"
import {
  ArrowUp,
  Brain,
  CircleCheck,
  CirclePause,
  CircleStop,
  CircleX,
  FileDiff,
  Layers,
  LoaderCircle,
  MessageCircle,
  Unplug,
  Wrench,
  X,
} from "lucide-react"
import {
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { mermaid } from "@streamdown/mermaid"
import { type Components, defaultComponents, Streamdown } from "streamdown"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block"
import { useHighlightedCode } from "@/hooks/use-highlighted-code"
import { Message, MessageContent, MessageGroup } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace"
import { AgentChanges } from "./AgentChanges"
import { AgentHeader, AgentHeaderAction } from "./AgentHeader"
import {
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemAttachment,
  QueueItemContent,
  QueueItemRow,
  QueueList,
} from "@/components/ui/queue"
import {
  type AgentTab,
  agentsAtom,
  changeModelAtom,
  changePermissionModeAtom,
  writtenAtom,
  placeKey,
  reachSandboxAtom,
} from "./agentsArea"
import {
  agentConversation,
  type Conversation,
  ConversationContext,
  useConversation,
} from "./conversation"
import { MessageText, readableText } from "./Mentions"
import { Attachment, type ComposerSuggestion, MessageBox } from "./MessageBox"
import { SentFeedback } from "./FeedbackNotes"
import { ModelPicker } from "./ModelPicker"
import { PermissionModePicker } from "./PermissionModePicker"
import { RequestCard, requestElementId } from "./RequestCard"
import { ProblemAlert } from "./ProblemAlert"
import { type Problem, problemText, settledProblem, streamProblem } from "./problems"
import { referenceText } from "./queue"
import { rememberPlace } from "./savedPlace"
import { shortcutLabel } from "./shortcutLabel"
import { useStagedFeedback } from "./useStagedFeedback"
import { useDarkColorScheme } from "./theme"
import { type FeedbackNotesStore, useFeedbackNotes } from "./useFeedbackNotes"
import { markTurnSeenAtom } from "./needsYou"
import { useShortcuts } from "./useShortcuts"
import { useWindowFocused } from "./useWindowFocused"

const TURNS_PER_PAGE = 20

interface AgentTabs {
  tab: AgentTab
  onTabChange: (tab: AgentTab) => void
}

const SAVE_DELAY_MS = 400

export const ToolCallView = createContext<
  ((call: typeof ToolCallPart.Type) => ReactNode | null) | null
>(null)

const lastSent = (
  turns: ReadonlyArray<Turn>,
  queued: ReadonlyArray<QueuedMessage>,
): SentMessage | null => {
  const turn = turns.at(-1)
  const steers = turn?.parts.flatMap((part) => (Predicate.isTagged(part, "Steer") ? [part] : []))
  const last = queued.at(-1) ?? steers?.at(-1) ?? turn

  return last === undefined || isNothingUnsent(last) ? null : sentOf(last)
}

export function AgentView(props: { agentId: string } & AgentTabs) {
  const agents = useAtomValue(agentsAtom)
  const agent = Option.getOrNull(AsyncResult.value(agents))?.find(({ id }) => id === props.agentId)

  if (agent === undefined)
    return (
      <section aria-label="Agent" className="flex min-h-0 flex-1 flex-col">
        <AgentHeader
          heading={<h1 className="truncate font-medium">Agent</h1>}
          place={null}
          baseBranch={null}
        />
        {AsyncResult.isSuccess(agents) && (
          <p className="p-6 text-sm text-muted-foreground">
            This Agent is gone. Pick another Agent or start a new one.
          </p>
        )}
      </section>
    )

  return <OpenAgent key={agent.id} agent={agent} tab={props.tab} onTabChange={props.onTabChange} />
}

function OpenAgent(props: { agent: Agent } & AgentTabs) {
  const { agent, tab, onTabChange } = props
  const conversation = useMemo(() => agentConversation(agent.id), [agent.id])
  const transcript = useAtomValue(conversation.transcript)
  const reconnect = useAtomRefresh(conversation.transcript)

  const { turns, queued, status } = Option.getOrElse(
    AsyncResult.value(transcript),
    () => emptyTranscript,
  )

  const [changesOpened, setChangesOpened] = useState(tab === "changes")

  if (tab === "changes" && !changesOpened) setChangesOpened(true)

  const registry = useContext(RegistryContext)

  useShortcuts([
    {
      key: "d",
      mod: true,
      allowInEditable: true,
      run: () => onTabChange(tab === "chat" ? "changes" : "chat"),
    },
  ])

  const reach = agent.sandbox?.reach
  const gone = isGone(reach) ? reach : null

  useEffect(() => {
    rememberPlace(registry, { area: "agents", agentId: agent.id })
  }, [registry, agent.id])

  const markTurnSeen = useAtomSet(markTurnSeenAtom)
  const focused = useWindowFocused()
  const endedAt = turns.at(-1)?.ended?.at

  useEffect(() => {
    if (focused && tab === "chat" && endedAt !== undefined)
      markTurnSeen({ agentId: agent.id, endedAt })
  }, [markTurnSeen, focused, tab, endedAt, agent.id])

  return (
    <ConversationContext value={conversation}>
      <section aria-label={agent.name} className="flex min-h-0 flex-1 flex-col">
        <AgentHeader
          heading={
            tab === "changes" ? (
              <>
                <button
                  type="button"
                  className="truncate text-muted-foreground hover:text-foreground"
                  onClick={() => onTabChange("chat")}
                >
                  {agent.name}
                </button>
                <span className="text-muted-foreground/50">/</span>
                <h1 className="font-medium">Changes</h1>
              </>
            ) : (
              <h1 className="truncate font-medium">{agent.name}</h1>
            )
          }
          place={agent.place}
          repository={repositoryKey(agent.repository)}
          branch={agent.name}
          baseBranch={agent.baseBranch}
          skillPacks={agent.skillPacks}
          localSkills={agent.localSkills}
        >
          {tab === "chat" ? (
            <AgentHeaderAction onSelect={() => onTabChange("changes")}>
              <FileDiff aria-hidden />
              Changes
              <Kbd className="ml-auto">{shortcutLabel("D")}</Kbd>
            </AgentHeaderAction>
          ) : (
            <AgentHeaderAction onSelect={() => onTabChange("chat")}>
              <MessageCircle aria-hidden />
              Back to Chat
              <Kbd className="ml-auto">{shortcutLabel("D")}</Kbd>
            </AgentHeaderAction>
          )}
        </AgentHeader>
        {AsyncResult.isFailure(transcript) && !transcript.waiting && (
          <div className="px-6 pt-4">
            <ProblemAlert
              problem={streamProblem(transcript.cause)}
              action={{ label: "Reconnect", run: reconnect }}
            />
          </div>
        )}
        <div hidden={tab !== "chat"} className="flex min-h-0 flex-1 flex-col">
          <Transcript turns={turns} status={status} />
          {reach === "unreachable" && <UnreachableNotice agentId={agent.id} />}
          {gone === null ? (
            <Composer agent={agent} turns={turns} queued={queued} />
          ) : (
            <output className="mx-auto block w-full max-w-3xl px-6 py-4 text-sm text-muted-foreground">
              {goneExplanation(gone)}
            </output>
          )}
        </div>
        <section
          aria-label="Changes"
          hidden={tab !== "changes"}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {changesOpened && (
            <AgentChanges
              agent={agent}
              turns={turns}
              onReviewFeedback={() => onTabChange("chat")}
            />
          )}
        </section>
      </section>
    </ConversationContext>
  )
}

export function Transcript(props: {
  turns: ReadonlyArray<Turn>
  status: string | null
  lead?: ReactNode
}) {
  const [shown, setShown] = useState(TURNS_PER_PAGE)
  const hidden = Math.max(0, props.turns.length - shown)
  const showMore = () => setShown((count) => count + TURNS_PER_PAGE)

  const showMoreWhenSeen = useCallback((element: HTMLButtonElement | null) => {
    if (element === null) return undefined

    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setShown((count) => count + TURNS_PER_PAGE)
    })

    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  return (
    <MessageScrollerProvider autoScroll scrollPreviousItemPeek={16}>
      <section aria-label="Transcript" className="flex min-h-0 flex-1 flex-col">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport className="px-6 py-4">
            <MessageScrollerContent className="mx-auto w-full max-w-3xl">
              {props.lead}
              {hidden > 0 && (
                <div className="text-center">
                  <Button ref={showMoreWhenSeen} variant="ghost" size="sm" onClick={showMore}>
                    Show {Math.min(hidden, TURNS_PER_PAGE)} earlier Turns
                  </Button>
                </div>
              )}
              {props.turns.slice(hidden).map((turn) => (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  latest={turn === props.turns.at(-1)}
                  status={turn === props.turns.at(-1) ? props.status : null}
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

function AttachedImages(props: { images: ReadonlyArray<Image> }) {
  return (
    props.images.length > 0 && (
      <div className="flex flex-wrap justify-end gap-2">
        {props.images.map((image, index) => (
          <Attachment
            key={index}
            image={image}
            index={index}
            className="max-h-40 max-w-60 rounded-lg border object-contain"
          />
        ))}
      </div>
    )
  )
}

export const contextLabel = (context: CapturedContext) =>
  Match.value(context).pipe(
    Match.tagsExhaustive({
      PullRequest: ({ pullRequest, revision }) =>
        `${referenceText(pullRequest)} at ${shortSha(revision.head)}`,
      Agent: ({ name }) => name,
    }),
  )

const sentFrom = (context: CapturedContext | null) =>
  context === null ? undefined : `From ${contextLabel(context)}`

const outcomeText: Record<ReportedWork["outcome"], string> = {
  finished: "finished",
  failed: "failed",
  waiting: "is waiting on you",
}

const reportedText = (work: ReportedWork) => {
  const subject = Match.valueTags(work, {
    Agent: ({ name }) => name,
    AgentReview: ({ pullRequest }) => `Agent review on ${referenceText(pullRequest)}`,
  })

  return `${subject} ${outcomeText[work.outcome]}`
}

function ReportMessage(props: { work: ReadonlyArray<ReportedWork> }) {
  return (
    <Message align="end">
      <MessageContent>
        <span className="self-end text-xs text-muted-foreground">Report from Glass</span>
        <ul className="flex flex-col gap-1 self-end text-sm text-muted-foreground">
          {props.work.map((work, index) => (
            <li key={index}>{reportedText(work)}</li>
          ))}
        </ul>
      </MessageContent>
    </Message>
  )
}

export function UserMessage(props: {
  message: string
  images: ReadonlyArray<Image>
  feedback?: ReadonlyArray<FeedbackNote>
  label?: string | undefined
}) {
  const feedback = props.feedback ?? []

  return (
    <Message align="end">
      <MessageContent>
        {props.label !== undefined && (
          <span className="self-end text-xs text-muted-foreground">{props.label}</span>
        )}
        <AttachedImages images={props.images} />
        {props.message !== "" && (
          <Bubble align="end" variant="muted">
            <BubbleContent className="whitespace-pre-wrap">
              <MessageText text={props.message} />
            </BubbleContent>
          </Bubble>
        )}
        {feedback.length > 0 && (
          <SentFeedback feedback={feedback} className="w-full max-w-xl self-end" />
        )}
      </MessageContent>
    </Message>
  )
}

const TurnView = memo(function TurnView(props: {
  turn: Turn
  latest: boolean
  status: string | null
}) {
  const { turn } = props

  return (
    <MessageScrollerItem messageId={turn.id} scrollAnchor exactHeight={props.latest}>
      <MessageGroup className="gap-4">
        {Predicate.isTagged(turn.context, "Report") ? (
          <ReportMessage work={turn.context.work} />
        ) : (
          <UserMessage
            message={turn.message}
            images={turn.images}
            feedback={turn.feedback}
            label={sentFrom(turn.context)}
          />
        )}
        <Message>
          <MessageContent>
            <TurnParts parts={turn.parts} />
            <Trace>
              {turn.ended === null ? (
                <TraceLine status="running">
                  <TraceIcon>
                    <LoaderCircle className="animate-spin" />
                  </TraceIcon>
                  <TraceTitle>{props.status === null ? "Working…" : `${props.status}…`}</TraceTitle>
                </TraceLine>
              ) : (
                <TurnEnding sentAt={turn.sentAt} ended={turn.ended} />
              )}
            </Trace>
          </MessageContent>
        </Message>
      </MessageGroup>
    </MessageScrollerItem>
  )
})

const elapsed = (sentAt: DateTime.Utc, ended: TurnEnd) => {
  const seconds = Math.round(
    (DateTime.toEpochMillis(ended.at) - DateTime.toEpochMillis(sentAt)) / 1000,
  )

  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function TurnEnding(props: { sentAt: DateTime.Utc; ended: TurnEnd }) {
  const duration = elapsed(props.sentAt, props.ended)

  return Match.value(props.ended.ending).pipe(
    Match.tagsExhaustive({
      Done: () => (
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
          <TraceTitle>Cut off after {duration} when Glass lost the Agent</TraceTitle>
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

interface NestedPart {
  readonly part: TurnPart
  readonly index: number
  readonly nested: ReadonlyArray<NestedPart>
}

const NOTHING_NESTED: ReadonlyArray<NestedPart> = []

const nestParts = (parts: ReadonlyArray<TurnPart>): ReadonlyArray<NestedPart> => {
  const calls = new Set(
    parts.flatMap((part) => (Predicate.isTagged(part, "ToolCall") ? [part.toolCallId] : [])),
  )

  const byParent = new Map<string | null, Array<number>>()

  parts.forEach((part, index) => {
    const parent =
      Predicate.isTagged(part, "ToolCall") &&
      part.parentToolCallId !== null &&
      calls.has(part.parentToolCallId)
        ? part.parentToolCallId
        : null

    const siblings = byParent.get(parent)

    if (siblings === undefined) byParent.set(parent, [index])
    else siblings.push(index)
  })

  const under = (parent: string | null): ReadonlyArray<NestedPart> =>
    (byParent.get(parent) ?? []).flatMap((index) => {
      const part = parts[index]

      if (part === undefined) return []

      const id = Predicate.isTagged(part, "ToolCall") ? part.toolCallId : null

      return [{ part, index, nested: id !== null && byParent.has(id) ? under(id) : NOTHING_NESTED }]
    })

  return under(null)
}

const groupSteps = (
  parts: ReadonlyArray<NestedPart>,
  isStep: (part: TurnPart) => boolean,
): ReadonlyArray<ReadonlyArray<NestedPart>> =>
  parts.reduce<Array<Array<NestedPart>>>((groups, item) => {
    const last = groups.at(-1)
    const lastItem = last?.at(-1)

    if (last !== undefined && lastItem !== undefined && isStep(lastItem.part) && isStep(item.part))
      last.push(item)
    else groups.push([item])

    return groups
  }, [])

const counted = (count: number, noun: string) =>
  count === 0 ? null : `${count} ${noun}${count === 1 ? "" : "s"}`

const runningCall = (parts: ReadonlyArray<TurnPart>) =>
  parts.find((part) => Predicate.isTagged(part, "ToolCall") && part.status === "running")

const stepsTitle = (parts: ReadonlyArray<TurnPart>) => {
  const calls = parts.filter((part) => Predicate.isTagged(part, "ToolCall"))
  const running = calls.find((call) => call.status === "running")
  const failed = calls.filter((call) => call.status === "failed").length

  const summary = [
    counted(calls.length, "tool call"),
    counted(parts.length - calls.length, "thought"),
    failed === 0 ? null : `${failed} failed`,
  ]
    .filter(Predicate.isString)
    .join(", ")

  return `${running === undefined ? "Worked" : `Running ${running.name}`} · ${summary}`
}

function TurnParts(props: { parts: ReadonlyArray<TurnPart> }) {
  const toolCallView = useContext(ToolCallView)

  const isStep = (part: TurnPart) =>
    Predicate.isTagged(part, "Thinking") ||
    (Predicate.isTagged(part, "ToolCall") && (toolCallView?.(part) ?? null) === null)

  return groupSteps(nestParts(props.parts), isStep).map((group) => {
    const [first] = group

    if (first === undefined) return null

    return group.length === 1 ? (
      <PartView key={first.index} part={first.part} nested={first.nested} />
    ) : (
      <Steps key={first.index} steps={group} />
    )
  })
}

function Steps(props: { steps: ReadonlyArray<NestedPart> }) {
  const parts = props.steps.map(({ part }) => part)

  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine status={runningCall(parts) === undefined ? undefined : "running"}>
            <TraceIcon>
              <Layers />
            </TraceIcon>
            <TraceTitle>{stepsTitle(parts)}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="flex flex-col gap-2">
          {props.steps.map(({ part, index, nested }) => (
            <PartView key={index} part={part} nested={nested} />
          ))}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

const toolStatus = {
  running: { label: "Running", line: "running" },
  done: { label: "Done", line: undefined },
  failed: { label: "Failed", line: "error" },
} as const

const markdownPlugins = { mermaid }

function FencedCode(props: { code: string; language: string }) {
  const lines = useHighlightedCode(props.code, props.language)

  return (
    <CodeBlock className="rounded-xl border-0 bg-muted dark:bg-muted">
      <CodeBlockHeader>
        <CodeBlockTitle>{props.language}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={props.code} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers>
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  )
}

const markdownComponents: Components = {
  code: (props) => {
    const language = /language-(\S+)/.exec(props.className ?? "")?.[1] ?? ""

    return "data-block" in props && language !== "mermaid" && Predicate.isString(props.children) ? (
      <FencedCode code={props.children} language={language} />
    ) : (
      <defaultComponents.code {...props} />
    )
  },
}

function AgentMarkdown(props: { text: string }) {
  const theme = useDarkColorScheme() ? "dark" : "default"

  return (
    <Streamdown
      className="text-sm"
      plugins={markdownPlugins}
      components={markdownComponents}
      mermaid={{ config: { theme } }}
    >
      {props.text}
    </Streamdown>
  )
}

const PartView = memo(function PartView(props: {
  part: TurnPart
  nested: ReadonlyArray<NestedPart>
}) {
  const toolCallView = useContext(ToolCallView)

  return Match.value(props.part).pipe(
    Match.tagsExhaustive({
      Text: ({ text }) => <AgentMarkdown text={text} />,
      Steer: ({ message, images, context }) => (
        <UserMessage
          label={["Steered", sentFrom(context)].filter(Predicate.isString).join(" · ")}
          message={message}
          images={images}
        />
      ),
      Thinking: ({ text }) => (
        <Trace>
          <TraceCollapsible>
            <TraceCollapsibleTrigger>
              <TraceLine>
                <TraceIcon>
                  <Brain />
                </TraceIcon>
                <TraceTitle>Thinking</TraceTitle>
              </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent className="whitespace-pre-wrap">
              {text}
            </TraceCollapsibleContent>
          </TraceCollapsible>
        </Trace>
      ),
      ToolCall: (call) => {
        const shown = toolCallView?.(call) ?? null

        if (shown !== null) return shown

        const status = toolStatus[call.status]

        return (
          <Trace>
            <TraceCollapsible>
              <TraceCollapsibleTrigger>
                <TraceLine status={status.line}>
                  <TraceIcon>
                    <Wrench />
                  </TraceIcon>
                  <TraceTitle>
                    <span className="sr-only">{status.label}: </span>
                    <span className="font-medium text-foreground">{call.name}</span>{" "}
                    <span className="font-mono text-xs">{call.inputSummary}</span>
                  </TraceTitle>
                </TraceLine>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent className="flex flex-col gap-2">
                <CodeBlock size="sm">
                  <CodeBlockContent wrap className="max-h-64">
                    {call.input}
                  </CodeBlockContent>
                </CodeBlock>
                {props.nested.length > 0 && (
                  <div className="flex flex-col gap-1 border-l pl-3">
                    {props.nested.map(({ part, index, nested }) => (
                      <PartView key={index} part={part} nested={nested} />
                    ))}
                  </div>
                )}
                {call.output !== null && (
                  <CodeBlock size="sm">
                    <CodeBlockContent
                      wrap
                      className={cn("max-h-80", call.status === "failed" && "text-destructive")}
                    >
                      {call.output}
                    </CodeBlockContent>
                  </CodeBlock>
                )}
              </TraceCollapsibleContent>
            </TraceCollapsible>
          </Trace>
        )
      },
      PermissionRequest: (request) => <RequestCard part={request} />,
      Question: (question) => <RequestCard part={question} />,
    }),
  )
})

const waitingNames = {
  PermissionRequest: "Permission request",
  Question: "Question",
} as const

const composerPlaceholder = (
  running: boolean,
  waiting: RequestPart | undefined,
  idle = "Message the Agent",
) => {
  if (waiting !== undefined) return `Answer the ${waitingNames[waiting._tag]} above first`

  return running ? "Queue a message, or Steer the Agent with ⌘Enter" : idle
}

function WaitingNotice(props: { waiting: RequestPart }) {
  const { waiting } = props

  const show = () =>
    document
      .getElementById(requestElementId(waiting.requestId))
      ?.scrollIntoView({ behavior: "smooth", block: "center" })

  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      The Agent waits on your answer to its {waitingNames[waiting._tag]}.
      <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={show}>
        Show it
      </Button>
    </p>
  )
}

function UnreachableNotice({ agentId }: { agentId: string }) {
  const tried = useAtomValue(reachSandboxAtom(agentId))
  const tryAgain = useAtomSet(reachSandboxAtom(agentId))
  const problem = settledProblem(tried)

  return (
    <output className="mx-auto block w-full max-w-3xl px-6 pt-2 text-sm text-muted-foreground">
      Glass can't reach this Agent's Sandbox. Once it answers, Glass fills in what the Agent did.{" "}
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto p-0"
        disabled={tried.waiting}
        onClick={() => tryAgain()}
      >
        Try again
      </Button>
      {problem !== null && <span className="block">{problemText(problem)}</span>}
    </output>
  )
}

function Composer(props: {
  agent: Agent
  turns: ReadonlyArray<Turn>
  queued: ReadonlyArray<QueuedMessage>
}) {
  const { agent } = props
  const changed = useAtomValue(changeModelAtom(agent.id))
  const changeModel = useAtomSet(changeModelAtom(agent.id))
  const modeChanged = useAtomValue(changePermissionModeAtom(agent.id))
  const changePermissionMode = useAtomSet(changePermissionModeAtom(agent.id))
  const feedback = useFeedbackNotes(agent.id)

  return (
    <AgentComposer
      turns={props.turns}
      queued={props.queued}
      feedback={feedback}
      problem={settledProblem(changed) ?? settledProblem(modeChanged)}
      pickers={
        <>
          <ModelPicker
            engine={agent.engine}
            placeKey={placeKey(agent.place)}
            model={agent.model}
            effort={agent.effort}
            onChange={changeModel}
          />
          {asksPermission(agent.place) && (
            <PermissionModePicker
              engine={agent.engine}
              permissionMode={agent.permissionMode}
              onChange={changePermissionMode}
            />
          )}
        </>
      }
    />
  )
}

export function AgentComposer(props: {
  turns: ReadonlyArray<Turn>
  queued: ReadonlyArray<QueuedMessage>
  label?: string
  idlePlaceholder?: string
  textOnly?: boolean
  problem?: Problem | null
  pickers?: ReactNode
  suggestions?: ReadonlyArray<ComposerSuggestion>
  feedback?: FeedbackNotesStore
}) {
  const { turns } = props
  const conversation = useConversation()
  const running = turns.at(-1)?.ended === null
  const waiting = turns.at(-1)?.parts.find(isWaiting)
  const [composed, setComposed] = usePersistedComposer(conversation)
  const commands = useAtomValue(conversation.commands)
  const files = useAtomValue(conversation.files)
  const sent = useAtomValue(conversation.send)
  const send = useAtomSet(conversation.send, { mode: "promiseExit" })
  const steered = useAtomValue(conversation.steer)
  const steer = useAtomSet(conversation.steer, { mode: "promiseExit" })
  const stopped = useAtomValue(conversation.stop)
  const stop = useAtomSet(conversation.stop)
  const canceled = useAtomValue(conversation.cancelQueued)
  const sentNow = useAtomValue(conversation.sendQueued)

  const { editing, ...staged } = useStagedFeedback(
    props.feedback,
    async (message) => Exit.isSuccess(await send(message)),
    async (message) => Exit.isSuccess(await steer(message)),
  )

  return (
    <>
      {props.queued.length > 0 && (
        <div className="px-6">
          <QueuedMessages queued={props.queued} running={running} />
        </div>
      )}
      <MessageBox
        composed={composed}
        setComposed={setComposed}
        label={props.label ?? "Message"}
        textOnly={props.textOnly ?? false}
        placeholder={composerPlaceholder(running, waiting, props.idlePlaceholder)}
        blocked={sent.waiting || steered.waiting || waiting !== undefined || editing}
        problem={
          settledProblem(sent) ??
          settledProblem(steered) ??
          settledProblem(stopped) ??
          settledProblem(canceled) ??
          settledProblem(sentNow) ??
          props.problem ??
          null
        }
        {...staged}
        recall={lastSent(turns, props.queued)}
        onStop={running ? () => stop() : null}
        notice={waiting !== undefined && <WaitingNotice waiting={waiting} />}
        commands={commands}
        files={files}
        pickers={props.pickers}
        suggestions={props.suggestions ?? []}
      />
    </>
  )
}

function usePersistedComposer(conversation: Conversation) {
  const registry = useContext(RegistryContext)
  const [written, setWritten] = useAtom(writtenAtom(conversation.composerKey))
  const kept = Option.getOrNull(AsyncResult.value(useAtomValue(conversation.unsent)))
  const composed = written ?? kept ?? nothingUnsent
  const unsaved = useRef<SentMessage | null>(null)

  useEffect(() => {
    if (written === null) return undefined

    unsaved.current = written

    const timer = setTimeout(() => {
      unsaved.current = null
      conversation.saveUnsent(registry, written)
    }, SAVE_DELAY_MS)

    return () => clearTimeout(timer)
  }, [registry, conversation, written])

  useEffect(
    () => () => {
      if (unsaved.current !== null) conversation.saveUnsent(registry, unsaved.current)
    },
    [registry, conversation],
  )

  const setComposed = useCallback(
    (update: (current: SentMessage) => SentMessage) => setWritten(update(composed)),
    [setWritten, composed],
  )

  return [composed, setComposed] as const
}

function QueuedMessages(props: { queued: ReadonlyArray<QueuedMessage>; running: boolean }) {
  const conversation = useConversation()
  const cancel = useAtomSet(conversation.cancelQueued)
  const sendNow = useAtomSet(conversation.sendQueued)

  return (
    <section aria-label="Queued messages" className="mx-auto flex max-w-3xl flex-col gap-1 pt-2">
      <p className="text-xs text-muted-foreground">
        {props.running ? "Starts when the Agent finishes" : "Waiting until you send them"}
      </p>
      <QueueList>
        {props.queued.map((queued) => {
          const feedbackOnly = queued.message === ""

          const readable = feedbackOnly
            ? "Feedback on the Agent's changes"
            : readableText(queued.message)

          return (
            <QueueItem key={queued.id} aria-label={readable}>
              <QueueItemRow>
                <QueueItemContent>
                  {feedbackOnly ? readable : <MessageText text={queued.message} />}
                  {queued.context !== null && (
                    <span className="block text-xs text-muted-foreground">
                      {sentFrom(queued.context)}
                    </span>
                  )}
                </QueueItemContent>
                <QueueItemActions>
                  {!props.running && (
                    <QueueItemAction
                      aria-label={`Send now: ${readable}`}
                      onClick={() => sendNow(queued.id)}
                    >
                      <ArrowUp />
                    </QueueItemAction>
                  )}
                  <QueueItemAction
                    aria-label={`Cancel: ${readable}`}
                    onClick={() => cancel(queued.id)}
                  >
                    <X />
                  </QueueItemAction>
                </QueueItemActions>
              </QueueItemRow>
              {queued.feedback.length > 0 && <SentFeedback feedback={queued.feedback} />}
              {queued.images.length > 0 && (
                <QueueItemAttachment>
                  {queued.images.map((image, index) => (
                    <Attachment
                      key={index}
                      image={image}
                      index={index}
                      className="size-8 rounded border object-cover"
                    />
                  ))}
                </QueueItemAttachment>
              )}
            </QueueItem>
          )
        })}
      </QueueList>
    </section>
  )
}
