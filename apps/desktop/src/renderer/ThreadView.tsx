import {
  RegistryContext,
  useAtom,
  useAtomMount,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react"
import {
  type Thread,
  emptyTranscript,
  asksPermission,
  goneExplanation,
  isGone,
  isNothingUnsent,
  isWaiting,
  nothingUnsent,
  type PullRequestRef,
  type QueuedMessage,
  referenceKey,
  repositoryKey,
  type RequestPart,
  type SentMessage,
  sentOf,
  type Turn,
} from "@glass/contracts"
import { cn } from "cn"
import { Exit, Option, Predicate } from "effect"
import { AsyncResult } from "effect/reactivity"
import {
  ArrowUp,
  FileDiff,
  GitPullRequest,
  Globe,
  PanelRightClose,
  PanelRightOpen,
  Workflow,
  X,
} from "lucide-react"
import {
  Activity,
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Button } from "@/components/ui/button"
import { AgentStatuses } from "./AgentStatuses"
import { Transcript } from "./Transcript"
import { BackgroundToolCalls, ToolCallView } from "./TurnParts"
import { sentFrom } from "./UserMessage"
import { threadColumn } from "./threadColumn"
import { ChangesPane } from "./ThreadChanges"
import { ThreadDetailsAction, ThreadFrame } from "./ThreadFrame"
import { ThreadName } from "./ThreadName"
import { PullRequestPanes, useThreadPullRequest } from "./ThreadPullRequest"
import { ThreadSubscriptions } from "./ThreadSubscriptions"
import { PullRequestPane } from "./PullRequestPane"
import { type PaneChoice, PanePicker } from "./PanePicker"
import { PreloadPullRequest } from "./preloadPullRequest"
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
  threadsAtom,
  transcriptAtom,
  changeModelAtom,
  changePermissionModeAtom,
  writtenAtom,
  placeKey,
  reachSandboxAtom,
} from "./threadsArea"
import { threadAtoms, type ThreadAtoms, ThreadAtomsContext, useThreadAtoms } from "./thread"
import { MessageText, readableText } from "./Mentions"
import { createImageViewer, ImageViewer } from "./ImageViewer"
import { Attachment, type ComposerSuggestion, MessageBox } from "./MessageBox"
import { SentFeedback } from "./FeedbackNotes"
import { ModelPicker } from "./ModelPicker"
import { PermissionModePicker } from "./PermissionModePicker"
import { requestElementId } from "./RequestCard"
import { ProblemAlert } from "./ProblemAlert"
import { type Problem, problemText, settledProblem, streamProblem } from "./problems"
import { rememberPlace } from "./savedPlace"
import { type Action, useActions } from "./actions"
import { useComposerFeedback } from "./useComposerFeedback"
import { DiagramPane, useDiagrams } from "./ThreadDiagrams"
import { BrowserLinks, type BrowserOpening, BrowserPane } from "./BrowserPane"
import { browserPolicyOf, threadFileAddress } from "./browserAddress"
import { useAgentHoldsBrowserPage } from "./browserPages"
import { FileLinks, FilePane, isHtmlFile, lastEndedOf, useFileLinks } from "./ThreadFiles"
import { type FeedbackNotesStore, useFeedbackNotes } from "./useFeedbackNotes"
import { markTurnSeenAtom } from "./inboxArea"
import { useWindowFocused } from "./useWindowFocused"

type SidePane =
  | { kind: "picker" }
  | { kind: "changes"; wide: boolean }
  | { kind: "diagram"; title: string }
  | { kind: "file"; path: string }
  | { kind: "browser"; opening: BrowserOpening }
  | { kind: "pullRequest"; pullRequest: PullRequestRef }
  | null

const SAVE_DELAY_MS = 400

const KEPT_THREADS = 4

const lastSent = (
  turns: ReadonlyArray<Turn>,
  queued: ReadonlyArray<QueuedMessage>,
): SentMessage | null => {
  const turn = turns.at(-1)
  const steers = turn?.parts.flatMap((part) => (Predicate.isTagged(part, "Steer") ? [part] : []))
  const last = queued.at(-1) ?? steers?.at(-1) ?? turn

  return last === undefined || isNothingUnsent(last) ? null : sentOf(last)
}

function useKeptThreads(shown: string | null, listed: ReadonlyArray<Thread>) {
  const [kept, setKept] = useState<ReadonlyArray<string>>([])

  if (shown !== null && kept[0] !== shown)
    setKept(
      [
        shown,
        ...kept.filter((id) => id !== shown && listed.some((thread) => thread.id === id)),
      ].slice(0, KEPT_THREADS),
    )

  return kept
}

export function ThreadViews(props: { threadId: string | null }) {
  const { threadId } = props
  const threads = useAtomValue(threadsAtom)
  const listed = Option.getOrElse(AsyncResult.value(threads), () => [])
  const listedShown = threadId !== null && listed.some(({ id }) => id === threadId)
  const kept = useKeptThreads(listedShown ? threadId : null, listed)

  return (
    <>
      {threadId !== null && !listedShown && (
        <ThreadFrame
          label="Thread"
          heading={<h1 className="truncate font-medium">Thread</h1>}
          details={null}
        >
          {AsyncResult.isSuccess(threads) && (
            <p className="p-6 text-sm text-muted-foreground">
              This Thread is gone. Pick another Thread or start a new one.
            </p>
          )}
        </ThreadFrame>
      )}
      {kept
        // WARNING: sorting by recency would move a kept Thread's DOM on a switch, losing its scroll position.
        .toSorted()
        .flatMap((id) => {
          const thread = listed.find((listedThread) => listedThread.id === id)

          return thread === undefined
            ? []
            : [
                <Fragment key={id}>
                  <KeepTranscript threadId={id} />
                  <Activity mode={id === threadId ? "visible" : "hidden"}>
                    <OpenThread thread={thread} />
                  </Activity>
                </Fragment>,
              ]
        })}
    </>
  )
}

function KeepTranscript(props: { threadId: string }) {
  useAtomMount(transcriptAtom(props.threadId))

  return null
}

const OpenThread = memo(function OpenThread(props: { thread: Thread }) {
  const { thread } = props
  const atoms = useMemo(() => threadAtoms(thread.id), [thread.id])
  const loaded = AsyncResult.value(useAtomValue(atoms.transcript))
  const { turns } = Option.getOrElse(loaded, () => emptyTranscript)

  const [pane, setPane] = useState<SidePane>(null)
  const openDiagram = useCallback((title: string) => setPane({ kind: "diagram", title }), [setPane])
  const closePane = useCallback(() => setPane(null), [setPane])
  const diagrams = useDiagrams(turns, Option.isSome(loaded), openDiagram)
  const openedDiagram = pane?.kind === "diagram" ? diagrams.diagrams.get(pane.title) : undefined

  const openBrowser = useCallback(
    (address: string | null) =>
      setPane((current) => ({
        kind: "browser",
        opening: { address, seq: current?.kind === "browser" ? current.opening.seq + 1 : 0 },
      })),
    [setPane],
  )

  const agentHoldsPage = useAgentHoldsBrowserPage(thread.id)
  const [seenAgentHold, setSeenAgentHold] = useState(false)

  // WARNING: BrowserPane's effects would load an old address over its page when shown again, so hiding the Thread closes it, as leaving a Thread always did.
  useEffect(
    () => () => {
      setPane((current) => (current?.kind === "browser" ? null : current))
      setSeenAgentHold(false)
    },
    [],
  )

  if (agentHoldsPage !== seenAgentHold) {
    setSeenAgentHold(agentHoldsPage)

    if (agentHoldsPage && pane?.kind !== "browser") openBrowser(null)
  }

  const openFile = useCallback(
    (path: string) =>
      isHtmlFile(path)
        ? openBrowser(threadFileAddress(thread.id, path))
        : setPane({ kind: "file", path }),
    [setPane, openBrowser, thread.id],
  )

  const policy = useMemo(() => browserPolicyOf(thread.place), [thread.place])
  const browserLinks = useMemo(() => ({ policy, open: openBrowser }), [policy, openBrowser])
  const fileLinks = useFileLinks(thread.id, turns, Option.isSome(loaded), openFile)

  const openPullRequestPane = useCallback(
    (pullRequest: PullRequestRef) => setPane({ kind: "pullRequest", pullRequest }),
    [setPane],
  )

  const openChanges = useCallback(() => setPane({ kind: "changes", wide: false }), [setPane])

  const pullRequest = useThreadPullRequest(thread.id)

  const registry = useContext(RegistryContext)

  const paneChoices: ReadonlyArray<PaneChoice> = [
    { id: "changes", label: "Changes", icon: FileDiff, key: "d", open: openChanges },
    { id: "browser", label: "Browser", icon: Globe, key: "b", open: () => openBrowser(null) },
    ...(pullRequest === undefined
      ? []
      : [
          {
            id: "pull-request",
            label: "Pull request",
            icon: GitPullRequest,
            key: "p",
            open: () => openPullRequestPane(pullRequest.ref),
          },
        ]),
    ...diagrams.titles.map((title) => ({
      id: `diagram:${title}`,
      label: title,
      icon: Workflow,
      open: () => openDiagram(title),
    })),
  ]

  useActions([
    {
      id: "thread-pane",
      title: pane === null ? "Open a pane" : "Close the pane",
      group: "Thread",
      icon: pane === null ? PanelRightOpen : PanelRightClose,
      shortcut: { key: "d", mod: true, allowInEditable: true },
      run: () => setPane((current) => (current === null ? { kind: "picker" } : null)),
    },
    ...paneChoices.map(({ id, label, icon, open }): Action => ({
      id: `thread-pane-${id}`,
      title: `Open ${label}`,
      group: "Thread",
      icon,
      run: open,
    })),
  ])

  const chatHidden = pane?.kind === "changes" && pane.wide

  useEffect(() => {
    rememberPlace(registry, { area: "threads", threadId: thread.id })
  }, [registry, thread.id])

  const markTurnSeen = useAtomSet(markTurnSeenAtom)
  const focused = useWindowFocused()
  const endedAt = turns.at(-1)?.ended?.at

  useEffect(() => {
    if (focused && !chatHidden && endedAt !== undefined)
      markTurnSeen({ threadId: thread.id, endedAt })
  }, [markTurnSeen, focused, chatHidden, endedAt, thread.id])

  return (
    <ThreadAtomsContext value={atoms}>
      <PullRequestPanes value={openPullRequestPane}>
        {pullRequest !== undefined && (
          <PreloadPullRequest key={referenceKey(pullRequest.ref)} pullRequest={pullRequest.ref} />
        )}
        <ThreadFrame
          label={thread.name}
          heading={
            <h1 className="truncate font-medium">
              <ThreadName name={thread.name} />
            </h1>
          }
          pinnable={pane === null}
          details={{
            place: thread.place,
            repository: repositoryKey(thread.repository),
            branch: thread.branch ?? undefined,
            baseBranch: thread.baseBranch,
            pullRequest,
            subscriptions: <ThreadSubscriptions threadId={thread.id} pullRequest={pullRequest} />,
            skillPacks: thread.skillPacks,
            localSkills: thread.localSkills,
            actions: paneChoices.map(({ id, label, icon: Icon, open }) => (
              <ThreadDetailsAction key={id} onNavigate={open}>
                <Icon aria-hidden className="text-muted-foreground" />
                <span className="truncate">{label}</span>
              </ThreadDetailsAction>
            )),
          }}
        >
          <TranscriptProblem />
          <div className="flex min-h-0 flex-1">
            <div hidden={chatHidden} className="flex min-h-0 min-w-0 flex-1">
              <ToolCallView value={diagrams.cardOf}>
                <FileLinks value={fileLinks}>
                  <BrowserLinks value={browserLinks}>
                    <ThreadChat thread={thread} place="thread" />
                  </BrowserLinks>
                </FileLinks>
              </ToolCallView>
            </div>
            {pane?.kind === "picker" && <PanePicker choices={paneChoices} onClose={closePane} />}
            {pane?.kind === "changes" && (
              <ChangesPane
                thread={thread}
                turns={turns}
                wide={pane.wide}
                onWideChange={(wide) =>
                  setPane((current) =>
                    current?.kind === "changes" ? { kind: "changes", wide } : current,
                  )
                }
                onClose={closePane}
              />
            )}
            {openedDiagram !== undefined && (
              <DiagramPane diagram={openedDiagram} onClose={closePane} />
            )}
            {pane?.kind === "file" && (
              <FilePane
                threadId={thread.id}
                path={pane.path}
                lastEnded={lastEndedOf(turns)}
                onClose={closePane}
              />
            )}
            {pane?.kind === "browser" && (
              <BrowserPane
                threadId={thread.id}
                policy={policy}
                lastEnded={lastEndedOf(turns)}
                opening={pane.opening}
                onClose={closePane}
              />
            )}
            {pane?.kind === "pullRequest" && (
              <PullRequestPane
                key={referenceKey(pane.pullRequest)}
                pullRequest={pane.pullRequest}
                onClose={closePane}
              />
            )}
          </div>
        </ThreadFrame>
      </PullRequestPanes>
    </ThreadAtomsContext>
  )
})

export function TranscriptProblem() {
  const atoms = useThreadAtoms()
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

export function ThreadChat(props: { thread: Thread; place: "thread" | "inbox" }) {
  const { thread } = props
  const atoms = useThreadAtoms()
  const loadEarlier = useAtomSet(atoms.loadEarlier)

  const { turns, earlierTurns, queued, status, agentStatuses, backgroundTasks } = Option.getOrElse(
    AsyncResult.value(useAtomValue(atoms.transcript)),
    () => emptyTranscript,
  )

  const inBackground = useMemo(
    () => new Set(backgroundTasks.flatMap(({ toolCallId }) => toolCallId ?? [])),
    [backgroundTasks],
  )

  const reach = thread.sandbox?.reach
  const readOnly = isGone(reach) ? goneExplanation(reach) : null

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <BackgroundToolCalls value={inBackground}>
        <Transcript
          turns={turns}
          earlierTurns={earlierTurns}
          onShowEarlier={loadEarlier}
          status={status}
          latestOnly={props.place === "inbox"}
        />
      </BackgroundToolCalls>
      <AgentStatuses threadId={thread.id} statuses={agentStatuses} tasks={backgroundTasks} />
      {reach === "unreachable" && <UnreachableNotice threadId={thread.id} />}
      {readOnly !== null ? (
        <output
          className={cn(threadColumn, "block w-full px-6 py-4 text-sm text-muted-foreground")}
        >
          {readOnly}
        </output>
      ) : props.place === "inbox" ? (
        <ReplyBox turns={turns} />
      ) : (
        <Composer thread={thread} turns={turns} queued={queued} />
      )}
    </div>
  )
}

function ReplyBox(props: { turns: ReadonlyArray<Turn> }) {
  const atoms = useThreadAtoms()
  const waiting = props.turns.at(-1)?.parts.find(isWaiting)
  const [composed, setComposed] = usePersistedComposer(atoms)
  const sent = useAtomValue(atoms.send)
  const send = useAtomSet(atoms.send, { mode: "promiseExit" })

  return (
    <MessageBox
      composed={composed}
      setComposed={setComposed}
      label="Reply"
      placeholder={composerPlaceholder(false, waiting, "Reply to the Thread")}
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

const waitingNames = {
  PermissionRequest: "Permission request",
  Question: "Question",
} as const

const composerPlaceholder = (
  running: boolean,
  waiting: RequestPart | undefined,
  idle = "Message the Thread",
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
      The Thread waits on your answer to its {waitingNames[waiting._tag]}.
      <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={show}>
        Show it
      </Button>
    </p>
  )
}

function UnreachableNotice({ threadId }: { threadId: string }) {
  const tried = useAtomValue(reachSandboxAtom(threadId))
  const tryAgain = useAtomSet(reachSandboxAtom(threadId))
  const problem = settledProblem(tried)

  return (
    <output className={cn(threadColumn, "block w-full px-6 pt-2 text-sm text-muted-foreground")}>
      Glass can't reach this Thread's Sandbox. Once it answers, Glass fills in what its agent did.{" "}
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
  thread: Thread
  turns: ReadonlyArray<Turn>
  queued: ReadonlyArray<QueuedMessage>
}) {
  const { thread } = props
  const changed = useAtomValue(changeModelAtom(thread.id))
  const changeModel = useAtomSet(changeModelAtom(thread.id))
  const modeChanged = useAtomValue(changePermissionModeAtom(thread.id))
  const changePermissionMode = useAtomSet(changePermissionModeAtom(thread.id))
  const feedback = useFeedbackNotes(thread.id)

  return (
    <ThreadComposer
      turns={props.turns}
      queued={props.queued}
      feedback={feedback}
      beam
      problem={settledProblem(changed) ?? settledProblem(modeChanged)}
      pickers={
        <>
          <ModelPicker
            harness={thread.harness}
            placeKey={placeKey(thread.place)}
            model={thread.model}
            effort={thread.effort}
            onChange={changeModel}
          />
          {asksPermission(thread.place) && (
            <PermissionModePicker
              harness={thread.harness}
              permissionMode={thread.permissionMode}
              onChange={changePermissionMode}
            />
          )}
        </>
      }
    />
  )
}

export function ThreadComposer(props: {
  turns: ReadonlyArray<Turn>
  queued: ReadonlyArray<QueuedMessage>
  label?: string
  idlePlaceholder?: string
  textOnly?: boolean
  problem?: Problem | null
  pickers?: ReactNode
  suggestions?: ReadonlyArray<ComposerSuggestion>
  feedback?: FeedbackNotesStore
  beam?: boolean
}) {
  const { turns } = props
  const atoms = useThreadAtoms()
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

  const { editing, ...feedback } = useComposerFeedback(
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
        {...feedback}
        recall={lastSent(turns, props.queued)}
        onStop={running ? () => stop() : null}
        beam={props.beam ?? false}
        notice={waiting !== undefined && <WaitingNotice waiting={waiting} />}
        commands={commands}
        files={files}
        pickers={props.pickers}
        suggestions={props.suggestions ?? []}
      />
    </>
  )
}

function usePersistedComposer(thread: ThreadAtoms) {
  const registry = useContext(RegistryContext)
  const [written, setWritten] = useAtom(writtenAtom(thread.composerKey))
  const kept = Option.getOrNull(AsyncResult.value(useAtomValue(thread.unsent)))
  const composed = written ?? kept ?? nothingUnsent
  const unsaved = useRef<SentMessage | null>(null)

  useEffect(() => {
    if (written === null) return undefined

    unsaved.current = written

    const timer = setTimeout(() => {
      unsaved.current = null
      thread.saveUnsent(registry, written)
    }, SAVE_DELAY_MS)

    return () => clearTimeout(timer)
  }, [registry, thread, written])

  useEffect(
    () => () => {
      if (unsaved.current !== null) thread.saveUnsent(registry, unsaved.current)
    },
    [registry, thread],
  )

  const setComposed = useCallback(
    (update: (current: SentMessage) => SentMessage) => setWritten(update(composed)),
    [setWritten, composed],
  )

  return [composed, setComposed] as const
}

function QueuedMessages(props: { queued: ReadonlyArray<QueuedMessage>; running: boolean }) {
  const atoms = useThreadAtoms()
  const cancel = useAtomSet(atoms.cancelQueued)
  const sendNow = useAtomSet(atoms.sendQueued)
  const [viewer] = useState(createImageViewer)

  return (
    <section aria-label="Queued messages" className={cn(threadColumn, "flex flex-col gap-1 pt-2")}>
      <p className="text-xs text-muted-foreground">
        {props.running ? "Starts when the agent finishes" : "Waiting until you send them"}
      </p>
      <QueueList>
        {props.queued.map((queued) => {
          const feedbackOnly = queued.message === ""

          const readable = feedbackOnly
            ? "Feedback notes without a message"
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
                  {queued.images.map((_, index) => (
                    <Attachment
                      key={index}
                      images={queued.images}
                      index={index}
                      viewer={viewer}
                      className="size-8 rounded border object-cover"
                    />
                  ))}
                </QueueItemAttachment>
              )}
            </QueueItem>
          )
        })}
      </QueueList>
      <ImageViewer controller={viewer} />
    </section>
  )
}
