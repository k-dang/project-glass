import {
  RegistryContext,
  useAtom,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react"
import {
  type Conversation,
  emptyTranscript,
  asksPermission,
  type CapturedContext,
  type WorkOutcome,
  type BackgroundWork,
  type FeedbackNote,
  type Image,
  isNothingUnsent,
  isWaiting,
  nothingUnsent,
  parsePullRequestReference,
  type QueuedMessage,
  repositoryKey,
  type RequestPart,
  type SentMessage,
  sentOf,
  type ToolCallPart,
  type Turn,
  type TurnEnd,
  type TurnPart,
  readOnlyExplanation,
  shortSha,
} from "@glass/contracts"
import { useNavigate } from "@tanstack/react-router"
import { cn } from "cn"
import { DateTime, Exit, Match, Option, Predicate } from "effect"
import { AsyncResult } from "effect/reactivity"
import {
  ArrowUp,
  Activity,
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
  Workflow,
  Wrench,
  X,
} from "lucide-react"
import {
  type ComponentProps,
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
import {
  type Components,
  defaultComponents,
  Streamdown,
  useIsCodeFenceIncomplete,
} from "streamdown"
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
import { ConversationChanges } from "./ConversationChanges"
import { ConversationHeader, ConversationHeaderAction } from "./ConversationHeader"
import { useConversationPullRequest } from "./ConversationPullRequest"
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
  type ConversationTab,
  conversationsAtom,
  changeModelAtom,
  changePermissionModeAtom,
  writtenAtom,
  placeKey,
  reachSandboxAtom,
} from "./conversationsArea"
import {
  conversationAtoms,
  type ConversationAtoms,
  ConversationAtomsContext,
  useConversationAtoms,
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
import { MermaidDiagram } from "./MermaidDiagram"
import { DiagramPane, useDiagrams } from "./ConversationDiagrams"
import { FileLink, FileLinks, FilePane, lastEndedOf, useFileLinks } from "./ConversationFiles"
import { type FeedbackNotesStore, useFeedbackNotes } from "./useFeedbackNotes"
import { markTurnSeenAtom } from "./needsYou"
import { useShortcuts } from "./useShortcuts"
import { useWindowFocused } from "./useWindowFocused"

type SidePane = { kind: "diagram"; title: string } | { kind: "file"; path: string } | null

interface ConversationTabs {
  tab: ConversationTab
  onTabChange: (tab: ConversationTab) => void
}

const SAVE_DELAY_MS = 400

export const ToolCallView = createContext<
  ((call: typeof ToolCallPart.Type) => ReactNode | null) | null
>(null)

const BackgroundToolCalls = createContext<ReadonlySet<string>>(new Set())

const lastSent = (
  turns: ReadonlyArray<Turn>,
  queued: ReadonlyArray<QueuedMessage>,
): SentMessage | null => {
  const turn = turns.at(-1)
  const steers = turn?.parts.flatMap((part) => (Predicate.isTagged(part, "Steer") ? [part] : []))
  const last = queued.at(-1) ?? steers?.at(-1) ?? turn

  return last === undefined || isNothingUnsent(last) ? null : sentOf(last)
}

export function ConversationView(props: { conversationId: string } & ConversationTabs) {
  const conversations = useAtomValue(conversationsAtom)

  const conversation = Option.getOrNull(AsyncResult.value(conversations))?.find(
    ({ id }) => id === props.conversationId,
  )

  if (conversation === undefined)
    return (
      <section aria-label="Conversation" className="flex min-h-0 flex-1 flex-col">
        <ConversationHeader
          heading={<h1 className="truncate font-medium">Conversation</h1>}
          place={null}
          baseBranch={null}
        />
        {AsyncResult.isSuccess(conversations) && (
          <p className="p-6 text-sm text-muted-foreground">
            This Conversation is gone. Pick another Conversation or start a new one.
          </p>
        )}
      </section>
    )

  return (
    <OpenConversation
      key={conversation.id}
      conversation={conversation}
      tab={props.tab}
      onTabChange={props.onTabChange}
    />
  )
}

function OpenConversation(props: { conversation: Conversation } & ConversationTabs) {
  const { conversation, tab, onTabChange } = props
  const atoms = useMemo(() => conversationAtoms(conversation.id), [conversation.id])
  const loaded = AsyncResult.value(useAtomValue(atoms.transcript))
  const { turns } = Option.getOrElse(loaded, () => emptyTranscript)

  const [changesOpened, setChangesOpened] = useState(tab === "changes")
  const [pane, setPane] = useState<SidePane>(null)
  const openDiagram = useCallback((title: string) => setPane({ kind: "diagram", title }), [setPane])
  const closePane = useCallback(() => setPane(null), [setPane])
  const diagrams = useDiagrams(turns, Option.isSome(loaded), openDiagram)
  const openedDiagram = pane?.kind === "diagram" ? diagrams.diagrams.get(pane.title) : undefined

  const openFile = useCallback((path: string) => setPane({ kind: "file", path }), [setPane])
  const fileLinks = useFileLinks(conversation.id, turns, Option.isSome(loaded), openFile)

  if (tab === "changes" && !changesOpened) setChangesOpened(true)

  const pullRequest = useConversationPullRequest(conversation.id)

  const registry = useContext(RegistryContext)

  useShortcuts([
    {
      key: "d",
      mod: true,
      allowInEditable: true,
      run: () => onTabChange(tab === "chat" ? "changes" : "chat"),
    },
  ])

  useEffect(() => {
    rememberPlace(registry, { area: "conversations", conversationId: conversation.id })
  }, [registry, conversation.id])

  const markTurnSeen = useAtomSet(markTurnSeenAtom)
  const focused = useWindowFocused()
  const endedAt = turns.at(-1)?.ended?.at

  useEffect(() => {
    if (focused && tab === "chat" && endedAt !== undefined)
      markTurnSeen({ conversationId: conversation.id, endedAt })
  }, [markTurnSeen, focused, tab, endedAt, conversation.id])

  return (
    <ConversationAtomsContext value={atoms}>
      <section aria-label={conversation.name} className="flex min-h-0 flex-1 flex-col">
        <ConversationHeader
          heading={
            tab === "changes" ? (
              <>
                <button
                  type="button"
                  className="truncate text-muted-foreground hover:text-foreground"
                  onClick={() => onTabChange("chat")}
                >
                  {conversation.name}
                </button>
                <span className="text-muted-foreground/50">/</span>
                <h1 className="font-medium">Changes</h1>
              </>
            ) : (
              <h1 className="truncate font-medium">{conversation.name}</h1>
            )
          }
          place={conversation.place}
          repository={repositoryKey(conversation.repository)}
          branch={conversation.branch ?? undefined}
          baseBranch={conversation.baseBranch}
          pullRequest={pullRequest}
          skillPacks={conversation.skillPacks}
          localSkills={conversation.localSkills}
        >
          {tab === "chat" ? (
            <>
              <ConversationHeaderAction onNavigate={() => onTabChange("changes")}>
                <FileDiff aria-hidden />
                Changes
                <Kbd className="ml-auto">{shortcutLabel("D")}</Kbd>
              </ConversationHeaderAction>
              {diagrams.titles.map((title) => (
                <ConversationHeaderAction key={title} onNavigate={() => openDiagram(title)}>
                  <Workflow aria-hidden />
                  <span className="truncate">{title}</span>
                </ConversationHeaderAction>
              ))}
            </>
          ) : (
            <ConversationHeaderAction onNavigate={() => onTabChange("chat")}>
              <MessageCircle aria-hidden />
              Back to Chat
              <Kbd className="ml-auto">{shortcutLabel("D")}</Kbd>
            </ConversationHeaderAction>
          )}
        </ConversationHeader>
        <TranscriptProblem />
        <div hidden={tab !== "chat"} className="flex min-h-0 flex-1">
          <ToolCallView value={diagrams.cardOf}>
            <FileLinks value={fileLinks}>
              <ConversationChat conversation={conversation} place="conversation" />
            </FileLinks>
          </ToolCallView>
          {openedDiagram !== undefined && (
            <DiagramPane diagram={openedDiagram} onClose={closePane} />
          )}
          {pane?.kind === "file" && (
            <FilePane
              conversationId={conversation.id}
              path={pane.path}
              lastEnded={lastEndedOf(turns)}
              onClose={closePane}
            />
          )}
        </div>
        <section
          aria-label="Changes"
          hidden={tab !== "changes"}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {changesOpened && (
            <ConversationChanges
              conversation={conversation}
              turns={turns}
              onReviewFeedback={() => onTabChange("chat")}
            />
          )}
        </section>
      </section>
    </ConversationAtomsContext>
  )
}

export function TranscriptProblem() {
  const atoms = useConversationAtoms()
  const transcript = useAtomValue(atoms.transcript)
  const reconnect = useAtomRefresh(atoms.transcript)

  return (
    AsyncResult.isFailure(transcript) &&
    !transcript.waiting && (
      <div className="px-6 pt-4">
        <ProblemAlert
          problem={streamProblem(transcript.cause)}
          action={{ label: "Reconnect", run: reconnect }}
        />
      </div>
    )
  )
}

// In the Inbox the chat shows only the latest Turn and a plain Reply box: a Conversation there
// is idle or waiting on the user, and leaves the Inbox as soon as a reply starts a Turn.
export function ConversationChat(props: {
  conversation: Conversation
  place: "conversation" | "inbox"
}) {
  const { conversation } = props
  const atoms = useConversationAtoms()
  const loadEarlier = useAtomSet(atoms.loadEarlier)

  const { turns, earlierTurns, queued, status, agentStatuses, backgroundToolCalls } =
    Option.getOrElse(AsyncResult.value(useAtomValue(atoms.transcript)), () => emptyTranscript)

  const reach = conversation.sandbox?.reach
  const readOnly = readOnlyExplanation(reach)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <BackgroundToolCalls value={new Set(backgroundToolCalls)}>
        <Transcript
          turns={turns}
          earlierTurns={earlierTurns}
          onShowEarlier={loadEarlier}
          status={status}
          latestOnly={props.place === "inbox"}
        />
      </BackgroundToolCalls>
      <AgentStatuses statuses={agentStatuses} />
      {reach === "unreachable" && <UnreachableNotice conversationId={conversation.id} />}
      {readOnly !== null ? (
        <output className="mx-auto block w-full max-w-3xl px-6 py-4 text-sm text-muted-foreground">
          {readOnly}
        </output>
      ) : props.place === "inbox" ? (
        <ReplyBox turns={turns} />
      ) : (
        <Composer conversation={conversation} turns={turns} queued={queued} />
      )}
    </div>
  )
}

function ReplyBox(props: { turns: ReadonlyArray<Turn> }) {
  const atoms = useConversationAtoms()
  const waiting = props.turns.at(-1)?.parts.find(isWaiting)
  const [composed, setComposed] = usePersistedComposer(atoms)
  const sent = useAtomValue(atoms.send)
  const send = useAtomSet(atoms.send, { mode: "promiseExit" })

  return (
    <MessageBox
      composed={composed}
      setComposed={setComposed}
      label="Reply"
      placeholder={composerPlaceholder(false, waiting, "Reply to the Conversation")}
      blocked={sent.waiting || waiting !== undefined}
      problem={settledProblem(sent)}
      send={async (message) => Exit.isSuccess(await send({ ...message, feedback: [] }))}
      steer={null}
      recall={null}
      onStop={null}
      notice={waiting !== undefined && <WaitingNotice waiting={waiting} />}
    />
  )
}

export function Transcript(props: {
  turns: ReadonlyArray<Turn>
  earlierTurns: number
  onShowEarlier: (before: string) => void
  status: string | null
  lead?: ReactNode
  latestOnly?: boolean
}) {
  const [revealed, setRevealed] = useState(!props.latestOnly)
  const collapsed = !revealed && (props.turns.length > 1 || props.earlierTurns > 0)
  const turns = collapsed ? props.turns.slice(-1) : props.turns
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
            <MessageScrollerContent className="mx-auto w-full max-w-3xl">
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
              {turns.map((turn) => (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  latest={turn === turns.at(-1)}
                  status={turn === turns.at(-1) ? props.status : null}
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
      Conversation: ({ name }) => name,
    }),
  )

const sentFrom = (context: CapturedContext | null) =>
  context === null ? undefined : `From ${contextLabel(context)}`

const outcomeText: Record<WorkOutcome["outcome"], string> = {
  finished: "finished",
  failed: "failed",
  waiting: "is waiting on you",
}

const workOutcomeText = (work: WorkOutcome) => {
  const subject = Match.valueTags(work, {
    Conversation: ({ name }) => name,
    AgentReview: ({ pullRequest }) => `Agent review on ${referenceText(pullRequest)}`,
  })

  return `${subject} ${outcomeText[work.outcome]}`
}

function GlobalConversationUpdateMessage(props: { work: ReadonlyArray<WorkOutcome> }) {
  return (
    <Message align="end">
      <MessageContent>
        <span className="self-end text-xs text-muted-foreground">
          Global conversation update from Glass
        </span>
        <ul className="flex flex-col gap-1 self-end text-sm text-muted-foreground">
          {props.work.map((work, index) => (
            <li key={index}>{workOutcomeText(work)}</li>
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

function BackgroundWorkEndedMessage(props: { work: ReadonlyArray<BackgroundWork> }) {
  return (
    <Message align="end">
      <MessageContent>
        <span className="self-end text-xs text-muted-foreground">Background work ended</span>
        <ul className="flex flex-col gap-1 self-end text-sm text-muted-foreground">
          {props.work.map((work, index) => (
            <li key={index}>{backgroundWorkText(work)}</li>
          ))}
        </ul>
      </MessageContent>
    </Message>
  )
}

function TurnMessage(props: { turn: Turn }) {
  const { turn } = props

  if (Predicate.isTagged(turn.context, "GlobalConversationUpdate"))
    return <GlobalConversationUpdateMessage work={turn.context.work} />

  if (Predicate.isTagged(turn.context, "BackgroundWorkEnded"))
    return <BackgroundWorkEndedMessage work={turn.context.work} />

  return (
    <UserMessage
      message={turn.message}
      images={turn.images}
      feedback={turn.feedback}
      label={sentFrom(turn.context)}
    />
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
        <TurnMessage turn={turn} />
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
          <TraceTitle>Cut off after {duration} when Glass lost the Conversation</TraceTitle>
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

const isRunning = (call: typeof ToolCallPart.Type, inBackground: ReadonlySet<string>) =>
  call.status === "running" || inBackground.has(call.toolCallId)

const runningCall = (parts: ReadonlyArray<TurnPart>, inBackground: ReadonlySet<string>) =>
  parts.find((part) => Predicate.isTagged(part, "ToolCall") && isRunning(part, inBackground))

const stepsTitle = (parts: ReadonlyArray<TurnPart>, inBackground: ReadonlySet<string>) => {
  const calls = parts.filter((part) => Predicate.isTagged(part, "ToolCall"))
  const running = calls.find((call) => isRunning(call, inBackground))
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
  const inBackground = useContext(BackgroundToolCalls)
  const parts = props.steps.map(({ part }) => part)

  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine
            status={runningCall(parts, inBackground) === undefined ? undefined : "running"}
          >
            <TraceIcon>
              <Layers />
            </TraceIcon>
            <TraceTitle>{stepsTitle(parts, inBackground)}</TraceTitle>
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
  background: { label: "Running in the background", line: "running" },
} as const

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

function MermaidBlock(props: { code: string }) {
  const incomplete = useIsCodeFenceIncomplete()
  const [invalid, setInvalid] = useState(false)
  const onInvalid = useCallback(() => setInvalid(true), [])

  return incomplete || invalid ? (
    <FencedCode code={props.code} language="mermaid" />
  ) : (
    <CodeBlock className="rounded-xl border-0 bg-muted dark:bg-muted">
      <CodeBlockHeader>
        <CodeBlockTitle>mermaid</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={props.code} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <div className="m-1.5 mt-3 rounded-lg bg-background p-3">
        <MermaidDiagram source={props.code} onInvalid={onInvalid} />
      </div>
    </CodeBlock>
  )
}

// A link to a GitHub PR opens its PR workspace; Cmd- or Ctrl-click still opens it on GitHub,
// skipping the link-safety prompt other links show since the URL is a parsed github.com PR.
// Streamdown's default renders that prompt as a button, so this mirrors the markup of Streamdown
// 2.7.1's plain anchor; recheck it when Streamdown moves.
function MarkdownLink(props: ComponentProps<typeof defaultComponents.a>) {
  const navigate = useNavigate()
  const pullRequest = props.href === undefined ? null : parsePullRequestReference(props.href)

  if (pullRequest === null) return <defaultComponents.a {...props} />

  return (
    <a
      className={cn("wrap-anywhere font-medium text-primary underline", props.className)}
      data-streamdown="link"
      href={props.href}
      rel="noreferrer"
      target="_blank"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey) return

        event.preventDefault()
        void navigate({ to: "/reviews/$owner/$repo/$number", params: pullRequest })
      }}
    >
      {props.children}
    </a>
  )
}

const markdownComponents: Components = {
  a: MarkdownLink,
  code: (props) => {
    const language = /language-(\S+)/.exec(props.className ?? "")?.[1] ?? ""

    if (!Predicate.isString(props.children)) return <defaultComponents.code {...props} />

    if (!("data-block" in props))
      return (
        <FileLink text={props.children}>
          <defaultComponents.code {...props} />
        </FileLink>
      )

    return language === "mermaid" ? (
      <MermaidBlock code={props.children} />
    ) : (
      <FencedCode code={props.children} language={language} />
    )
  },
}

function ConversationMarkdown(props: { text: string }) {
  return (
    <Streamdown className="text-sm" components={markdownComponents}>
      {props.text}
    </Streamdown>
  )
}

const PartView = memo(function PartView(props: {
  part: TurnPart
  nested: ReadonlyArray<NestedPart>
}) {
  const toolCallView = useContext(ToolCallView)
  const inBackground = useContext(BackgroundToolCalls)

  return Match.value(props.part).pipe(
    Match.tagsExhaustive({
      Text: ({ text }) => <ConversationMarkdown text={text} />,
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

        const background = call.status === "done" && inBackground.has(call.toolCallId)
        const status = toolStatus[background ? "background" : call.status]

        return (
          <Trace>
            <TraceCollapsible>
              <TraceCollapsibleTrigger>
                <TraceLine status={status.line}>
                  <TraceIcon>
                    <Wrench />
                  </TraceIcon>
                  <TraceTitle className="flex items-center gap-1">
                    <span className="sr-only">{status.label}: </span>
                    <span className="shrink-0 font-medium text-foreground">{call.name}</span>{" "}
                    <span className="truncate font-mono text-xs">{call.inputSummary}</span>
                    {background && (
                      <span aria-hidden className="shrink-0 text-xs">
                        · in the background
                      </span>
                    )}
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
  idle = "Message the Conversation",
) => {
  if (waiting !== undefined) return `Answer the ${waitingNames[waiting._tag]} above first`

  return running ? "Queue a message, or Steer the agent with ⌘Enter" : idle
}

function WaitingNotice(props: { waiting: RequestPart }) {
  const { waiting } = props

  const show = () =>
    document
      .getElementById(requestElementId(waiting.requestId))
      ?.scrollIntoView({ behavior: "smooth", block: "center" })

  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      The Conversation waits on your answer to its {waitingNames[waiting._tag]}.
      <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={show}>
        Show it
      </Button>
    </p>
  )
}

function AgentStatuses(props: { statuses: ReadonlyArray<string> }) {
  return (
    props.statuses.length > 0 && (
      <output
        aria-label="Agent statuses"
        className="mx-auto flex w-full max-w-3xl flex-wrap gap-x-4 gap-y-1 px-6 pt-2 text-xs text-muted-foreground"
      >
        {props.statuses.map((status) => (
          <span key={status} className="flex items-center gap-1.5">
            <Activity aria-hidden className="size-3" />
            {status}
          </span>
        ))}
      </output>
    )
  )
}

function UnreachableNotice({ conversationId }: { conversationId: string }) {
  const tried = useAtomValue(reachSandboxAtom(conversationId))
  const tryAgain = useAtomSet(reachSandboxAtom(conversationId))
  const problem = settledProblem(tried)

  return (
    <output className="mx-auto block w-full max-w-3xl px-6 pt-2 text-sm text-muted-foreground">
      Glass can't reach this Conversation's Sandbox. Once it answers, Glass fills in what its agent
      did.{" "}
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
  conversation: Conversation
  turns: ReadonlyArray<Turn>
  queued: ReadonlyArray<QueuedMessage>
}) {
  const { conversation } = props
  const changed = useAtomValue(changeModelAtom(conversation.id))
  const changeModel = useAtomSet(changeModelAtom(conversation.id))
  const modeChanged = useAtomValue(changePermissionModeAtom(conversation.id))
  const changePermissionMode = useAtomSet(changePermissionModeAtom(conversation.id))
  const feedback = useFeedbackNotes(conversation.id)

  return (
    <ConversationComposer
      turns={props.turns}
      queued={props.queued}
      feedback={feedback}
      problem={settledProblem(changed) ?? settledProblem(modeChanged)}
      pickers={
        <>
          <ModelPicker
            harness={conversation.harness}
            placeKey={placeKey(conversation.place)}
            model={conversation.model}
            effort={conversation.effort}
            onChange={changeModel}
          />
          {asksPermission(conversation.place) && (
            <PermissionModePicker
              harness={conversation.harness}
              permissionMode={conversation.permissionMode}
              onChange={changePermissionMode}
            />
          )}
        </>
      }
    />
  )
}

export function ConversationComposer(props: {
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
  const atoms = useConversationAtoms()
  const running = turns.at(-1)?.ended === null
  const waiting = turns.at(-1)?.parts.find(isWaiting)
  const [composed, setComposed] = usePersistedComposer(atoms)
  const commands = useAtomValue(atoms.commands)
  const files = useAtomValue(atoms.files)
  const sent = useAtomValue(atoms.send)
  const send = useAtomSet(atoms.send, { mode: "promiseExit" })
  const steered = useAtomValue(atoms.steer)
  const steer = useAtomSet(atoms.steer, { mode: "promiseExit" })
  const stopped = useAtomValue(atoms.stop)
  const stop = useAtomSet(atoms.stop)
  const canceled = useAtomValue(atoms.cancelQueued)
  const sentNow = useAtomValue(atoms.sendQueued)

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

function usePersistedComposer(conversation: ConversationAtoms) {
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
  const atoms = useConversationAtoms()
  const cancel = useAtomSet(atoms.cancelQueued)
  const sendNow = useAtomSet(atoms.sendQueued)

  return (
    <section aria-label="Queued messages" className="mx-auto flex max-w-3xl flex-col gap-1 pt-2">
      <p className="text-xs text-muted-foreground">
        {props.running ? "Starts when the agent finishes" : "Waiting until you send them"}
      </p>
      <QueueList>
        {props.queued.map((queued) => {
          const feedbackOnly = queued.message === ""

          const readable = feedbackOnly
            ? "Feedback on the Conversation's changes"
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
