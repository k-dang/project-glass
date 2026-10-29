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
  engineCapabilities,
  type Image,
  isWaiting,
  nothingUnsent,
  type QueuedMessage,
  repositoryKey,
  type RequestPart,
  type SentMessage,
  sentOf,
  type Turn,
  type TurnEnd,
  type TurnPart,
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
  LoaderCircle,
  MessageCircle,
  Unplug,
  Wrench,
  X,
} from "lucide-react"
import { memo, useCallback, useContext, useEffect, useRef, useState } from "react"
import { Streamdown } from "streamdown"
import { Button } from "@/components/ui/button"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
  cancelQueuedAtom,
  changeModelAtom,
  changePermissionModeAtom,
  writtenAtom,
  machineNames,
  placeKey,
  saveUnsent,
  sendMessageAtom,
  sendQueuedAtom,
  steerAtom,
  stopTurnAtom,
  transcriptAtom,
  unsentMessageAtom,
} from "./agentsArea"
import { Attachment, MessageBox } from "./MessageBox"
import { ModelPicker } from "./ModelPicker"
import { PermissionModePicker } from "./PermissionModePicker"
import { RequestCard, requestElementId } from "./RequestCard"
import { ProblemAlert } from "./ProblemAlert"
import { settledProblem, streamProblem } from "./problems"
import { rememberPlace } from "./savedPlace"

const TURNS_PER_PAGE = 20

interface AgentTabs {
  tab: AgentTab
  onTabChange: (tab: AgentTab) => void
}

const SAVE_DELAY_MS = 400

const lastSent = (
  turns: ReadonlyArray<Turn>,
  queued: ReadonlyArray<QueuedMessage>,
): SentMessage | null => {
  const turn = turns.at(-1)
  const steers = turn?.parts.flatMap((part) => (Predicate.isTagged(part, "Steer") ? [part] : []))
  const last = queued.at(-1) ?? steers?.at(-1) ?? turn

  return last === undefined ? null : sentOf(last)
}

export function AgentView(props: { agentId: string } & AgentTabs) {
  const agents = useAtomValue(agentsAtom)
  const agent = Option.getOrNull(AsyncResult.value(agents))?.find(({ id }) => id === props.agentId)

  if (agent === undefined)
    return AsyncResult.isSuccess(agents) ? (
      <p className="p-6 text-sm text-muted-foreground">
        This Agent is gone. Pick another Agent or start a new one.
      </p>
    ) : null

  return <OpenAgent key={agent.id} agent={agent} tab={props.tab} onTabChange={props.onTabChange} />
}

function OpenAgent(props: { agent: Agent } & AgentTabs) {
  const { agent, tab, onTabChange } = props
  const transcript = useAtomValue(transcriptAtom(agent.id))
  const reconnect = useAtomRefresh(transcriptAtom(agent.id))

  const { turns, queued, status } = Option.getOrElse(
    AsyncResult.value(transcript),
    () => emptyTranscript,
  )

  const running = turns.at(-1)?.ended === null
  const [changesOpened, setChangesOpened] = useState(tab === "changes")

  if (tab === "changes" && !changesOpened) setChangesOpened(true)

  const waiting = turns.at(-1)?.parts.find(isWaiting)
  const registry = useContext(RegistryContext)

  useEffect(() => {
    rememberPlace(registry, { area: "agents", agentId: agent.id })
  }, [registry, agent.id])

  return (
    <Tabs
      value={tab}
      onValueChange={onTabChange}
      render={<section aria-label={agent.name} />}
      className="min-h-0 flex-1 gap-0"
    >
      <header className="flex items-center gap-2 border-b px-6">
        <h1 className="shrink-0 py-2 text-sm font-medium">{agent.name}</h1>
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {repositoryKey(agent.repository)} · from {agent.baseBranch} ·{" "}
          {machineNames[agent.place._tag]}
        </p>
        <TabsList variant="line" aria-label="Agent" className="shrink-0 self-stretch">
          <TabsTrigger value="chat" className="flex-none px-2">
            <MessageCircle aria-hidden />
            Chat
          </TabsTrigger>
          <TabsTrigger value="changes" className="flex-none px-2">
            <FileDiff aria-hidden />
            Changes
          </TabsTrigger>
        </TabsList>
      </header>
      {AsyncResult.isFailure(transcript) && !transcript.waiting && (
        <div className="px-6 pt-4">
          <ProblemAlert
            problem={streamProblem(transcript.cause)}
            action={{ label: "Reconnect", run: reconnect }}
          />
        </div>
      )}
      <TabsContent value="chat" keepMounted className="flex min-h-0 flex-col">
        <Transcript agentId={agent.id} turns={turns} status={status} />
        <Composer agent={agent} running={running} waiting={waiting} turns={turns} queued={queued} />
      </TabsContent>
      <TabsContent value="changes" keepMounted className="flex min-h-0 min-w-0 flex-col">
        {changesOpened && <AgentChanges agent={agent} turns={turns} />}
      </TabsContent>
    </Tabs>
  )
}

function Transcript(props: { agentId: string; turns: ReadonlyArray<Turn>; status: string | null }) {
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
    <MessageScrollerProvider autoScroll>
      <section aria-label="Transcript" className="flex min-h-0 flex-1 flex-col">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport className="px-6 py-4">
            <MessageScrollerContent className="mx-auto w-full max-w-3xl">
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
                  agentId={props.agentId}
                  turn={turn}
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

export function UserMessage(props: {
  message: string
  images: ReadonlyArray<Image>
  label?: string
}) {
  return (
    <Message align="end">
      <MessageContent>
        {props.label !== undefined && (
          <span className="self-end text-xs text-muted-foreground">{props.label}</span>
        )}
        <AttachedImages images={props.images} />
        <Bubble align="end" variant="muted">
          <BubbleContent className="whitespace-pre-wrap">{props.message}</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
}

const TurnView = memo(function TurnView(props: {
  agentId: string
  turn: Turn
  status: string | null
}) {
  const { turn } = props

  return (
    <MessageScrollerItem messageId={turn.id} scrollAnchor>
      <MessageGroup className="gap-4">
        <UserMessage message={turn.message} images={turn.images} />
        <Message>
          <MessageContent>
            {nestParts(turn.parts).map(({ part, index, nested }) => (
              <PartView key={index} agentId={props.agentId} part={part} nested={nested} />
            ))}
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

const toolStatus = {
  running: { label: "Running", line: "running" },
  done: { label: "Done", line: undefined },
  failed: { label: "Failed", line: "error" },
} as const

const PartView = memo(function PartView(props: {
  agentId: string
  part: TurnPart
  nested: ReadonlyArray<NestedPart>
}) {
  return Match.value(props.part).pipe(
    Match.tagsExhaustive({
      Text: ({ text }) => <Streamdown className="text-sm">{text}</Streamdown>,
      Steer: ({ message, images }) => (
        <UserMessage label="Steered" message={message} images={images} />
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
                      <PartView key={index} agentId={props.agentId} part={part} nested={nested} />
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
      PermissionRequest: (request) => <RequestCard agentId={props.agentId} part={request} />,
      Question: (question) => <RequestCard agentId={props.agentId} part={question} />,
    }),
  )
})

const waitingNames = {
  PermissionRequest: "Permission request",
  Question: "Question",
} as const

const composerPlaceholder = (
  running: boolean,
  canSteer: boolean,
  waiting: RequestPart | undefined,
) => {
  if (waiting !== undefined) return `Answer the ${waitingNames[waiting._tag]} above first`

  if (!running) return "Message the Agent"

  return canSteer
    ? "Queue a message, or Steer the Agent with ⌘Enter"
    : "Queue a message for when the Agent finishes"
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

function Composer(props: {
  agent: Agent
  running: boolean
  waiting: RequestPart | undefined
  turns: ReadonlyArray<Turn>
  queued: ReadonlyArray<QueuedMessage>
}) {
  const { agent, running, waiting } = props
  const [composed, setComposed] = usePersistedComposer(agent.id)
  const sent = useAtomValue(sendMessageAtom(agent.id))
  const send = useAtomSet(sendMessageAtom(agent.id), { mode: "promiseExit" })
  const steered = useAtomValue(steerAtom(agent.id))
  const steer = useAtomSet(steerAtom(agent.id), { mode: "promiseExit" })
  const stopped = useAtomValue(stopTurnAtom(agent.id))
  const stop = useAtomSet(stopTurnAtom(agent.id))
  const changed = useAtomValue(changeModelAtom(agent.id))
  const changeModel = useAtomSet(changeModelAtom(agent.id))
  const modeChanged = useAtomValue(changePermissionModeAtom(agent.id))
  const changePermissionMode = useAtomSet(changePermissionModeAtom(agent.id))
  const canSteer = engineCapabilities[agent.engine].steer

  return (
    <>
      {props.queued.length > 0 && (
        <div className="px-6">
          <QueuedMessages agentId={agent.id} queued={props.queued} running={running} />
        </div>
      )}
      <MessageBox
        composed={composed}
        setComposed={setComposed}
        placeholder={composerPlaceholder(running, canSteer, waiting)}
        blocked={sent.waiting || steered.waiting || waiting !== undefined}
        problem={
          settledProblem(sent) ??
          settledProblem(steered) ??
          settledProblem(stopped) ??
          settledProblem(changed) ??
          settledProblem(modeChanged)
        }
        send={async (message) => Exit.isSuccess(await send(message))}
        steer={canSteer ? async (message) => Exit.isSuccess(await steer(message)) : null}
        recall={lastSent(props.turns, props.queued)}
        onStop={running ? () => stop() : null}
        notice={waiting !== undefined && <WaitingNotice waiting={waiting} />}
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
    </>
  )
}

function usePersistedComposer(agentId: string) {
  const registry = useContext(RegistryContext)
  const [written, setWritten] = useAtom(writtenAtom(agentId))
  const kept = Option.getOrNull(AsyncResult.value(useAtomValue(unsentMessageAtom(agentId))))
  const composed = written ?? kept ?? nothingUnsent
  const unsaved = useRef<SentMessage | null>(null)

  useEffect(() => {
    if (written === null) return undefined

    unsaved.current = written

    const timer = setTimeout(() => {
      unsaved.current = null
      saveUnsent(registry, agentId, written)
    }, SAVE_DELAY_MS)

    return () => clearTimeout(timer)
  }, [registry, agentId, written])

  useEffect(
    () => () => {
      if (unsaved.current !== null) saveUnsent(registry, agentId, unsaved.current)
    },
    [registry, agentId],
  )

  const setComposed = useCallback(
    (update: (current: SentMessage) => SentMessage) => setWritten(update(composed)),
    [setWritten, composed],
  )

  return [composed, setComposed] as const
}

function QueuedMessages(props: {
  agentId: string
  queued: ReadonlyArray<QueuedMessage>
  running: boolean
}) {
  const cancel = useAtomSet(cancelQueuedAtom(props.agentId))
  const sendNow = useAtomSet(sendQueuedAtom(props.agentId))

  return (
    <section aria-label="Queued messages" className="mx-auto flex max-w-3xl flex-col gap-1 pt-2">
      <p className="text-xs text-muted-foreground">
        {props.running ? "Starts when the Agent finishes" : "Waiting until you send them"}
      </p>
      <QueueList>
        {props.queued.map((queued) => (
          <QueueItem key={queued.id} aria-label={queued.message}>
            <QueueItemRow>
              <QueueItemContent>{queued.message}</QueueItemContent>
              <QueueItemActions>
                {!props.running && (
                  <QueueItemAction
                    aria-label={`Send now: ${queued.message}`}
                    onClick={() => sendNow(queued.id)}
                  >
                    <ArrowUp />
                  </QueueItemAction>
                )}
                <QueueItemAction
                  aria-label={`Cancel: ${queued.message}`}
                  onClick={() => cancel(queued.id)}
                >
                  <X />
                </QueueItemAction>
              </QueueItemActions>
            </QueueItemRow>
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
        ))}
      </QueueList>
    </section>
  )
}
