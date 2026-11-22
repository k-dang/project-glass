import { PageEvent, type PageLocation } from "@glass/contracts"
import {
  BROWSER_PARTITION,
  PAGE_EVENT_CHANNEL,
  SANDBOX_BROWSER_PARTITION,
} from "@glass/contracts/desktop"
import { Option, Predicate, Schema } from "effect"
import { Atom } from "effect/reactivity"
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  ExternalLink,
  MousePointerClick,
  RotateCw,
  X,
} from "lucide-react"
import {
  createContext,
  type FormEvent,
  type KeyboardEvent,
  memo,
  useEffect,
  useRef,
  useState,
} from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Toggle } from "@/components/ui/toggle"
import { addressOf, type BrowserPolicy, pageOf, webAddress } from "./browserAddress"
import {
  browserPageReady,
  liveBrowserPage,
  showBrowserPage,
  usePaneBrowserPage,
} from "./browserPages"
import { fileName } from "./fileName"
import { PageNotes } from "./PageNotes"
import { SidePanel } from "./SidePanel"

export const BrowserLinks = createContext<{
  readonly policy: BrowserPolicy
  readonly open: (address: string) => void
} | null>(null)

export interface BrowserOpening {
  readonly address: string | null
  readonly seq: number
}

const decodeEvent = Schema.decodeUnknownOption(PageEvent)

const isReady = (message: { readonly channel: string; readonly args: ReadonlyArray<unknown> }) =>
  message.channel === PAGE_EVENT_CHANNEL &&
  Option.exists(decodeEvent(message.args[0]), ({ type }) => type === "ready")

const paneWidthAtom = Atom.make(720).pipe(Atom.keepAlive)

const rememberedKey = (threadId: string) => `glass.browserPane.${threadId}`

const remembered = (threadId: string) => localStorage.getItem(rememberedKey(threadId))

const remember = (threadId: string, address: string) =>
  localStorage.setItem(rememberedKey(threadId), address)

const pageKey = (page: PageLocation) =>
  Predicate.isTagged(page, "FilePage") ? `file:${page.path}` : `web:${page.url}`

export const BrowserPane = memo(function BrowserPane(props: {
  threadId: string
  policy: BrowserPolicy
  opening: BrowserOpening
  lastEnded: string | null
  onClose: () => void
}) {
  const { threadId, policy } = props

  const [start] = useState(
    () =>
      props.opening.address ?? (liveBrowserPage(threadId) === null ? remembered(threadId) : null),
  )

  const [seenSeq, setSeenSeq] = useState<number | null>(null)

  const view = usePaneBrowserPage(
    threadId,
    policy.local ? BROWSER_PARTITION : SANDBOX_BROWSER_PARTITION,
  )

  const [attached, setAttached] = useState(false)
  const slot = useRef<HTMLDivElement>(null)
  const [requested, setRequested] = useState<{ readonly address: string } | null>(null)
  const [blocked, setBlocked] = useState<string | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [typed, setTyped] = useState(start ?? "")
  const [title, setTitle] = useState("")
  const [history, setHistory] = useState({ back: false, forward: false })
  const [loading, setLoading] = useState(false)
  const [pick, setPick] = useState(false)
  const [loads, setLoads] = useState(0)
  const [reloads, setReloads] = useState(0)
  const addressInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (start === null) addressInput.current?.focus()
  }, [start])

  const open = (next: string) => {
    setTyped(next)

    if (policy.allows(next)) {
      setBlocked(null)
      setRequested({ address: next })
    } else {
      setBlocked(next)
    }
  }

  if (props.opening.seq !== seenSeq) {
    setSeenSeq(props.opening.seq)

    const next = seenSeq === null ? start : props.opening.address

    if (next !== null) open(next)
  }

  useEffect(() => {
    if (attached && requested !== null) void view?.loadURL(requested.address).catch(() => undefined)
  }, [attached, requested, view])

  useEffect(() => {
    if (view === null) return undefined

    let cancelled = false

    const navigated = (url: string) => {
      const shown = url === "about:blank" ? null : url

      setAddress(shown)
      setTyped(shown ?? "")
      setPick(false)
      setHistory({ back: view.canGoBack(), forward: view.canGoForward() })

      if (shown !== null) remember(threadId, shown)
    }

    const onNavigate = (event: { readonly url: string }) => navigated(event.url)

    const onNavigateInPage = (event: { readonly url: string; readonly isMainFrame: boolean }) => {
      if (event.isMainFrame) navigated(event.url)
    }

    const onTitle = (event: { readonly title: string }) => setTitle(event.title)
    const onLoading = () => setLoading(true)
    const onLoaded = () => setLoading(false)

    const onMessage = (message: {
      readonly channel: string
      readonly args: ReadonlyArray<unknown>
    }) => {
      if (isReady(message)) setLoads((count) => count + 1)
    }

    view.addEventListener("did-navigate", onNavigate)
    view.addEventListener("did-navigate-in-page", onNavigateInPage)
    view.addEventListener("page-title-updated", onTitle)
    view.addEventListener("did-start-loading", onLoading)
    view.addEventListener("did-stop-loading", onLoaded)
    view.addEventListener("ipc-message", onMessage)

    void browserPageReady(threadId).then(
      () => {
        if (cancelled) return

        setAttached(true)

        const url = view.getURL()

        if (url === "about:blank") return

        navigated(url)
        setTitle(view.getTitle())
        setLoads((count) => Math.max(count, 1))
      },
      () => undefined,
    )

    return () => {
      cancelled = true
      view.removeEventListener("did-navigate", onNavigate)
      view.removeEventListener("did-navigate-in-page", onNavigateInPage)
      view.removeEventListener("page-title-updated", onTitle)
      view.removeEventListener("did-start-loading", onLoading)
      view.removeEventListener("did-stop-loading", onLoaded)
      view.removeEventListener("ipc-message", onMessage)
    }
  }, [view, threadId])

  const [seenEnded, setSeenEnded] = useState(props.lastEnded)
  const page = address === null ? null : pageOf(threadId, address)
  const showsFile = page !== null && Predicate.isTagged(page, "FilePage")

  if (props.lastEnded !== seenEnded) {
    setSeenEnded(props.lastEnded)

    if (showsFile) setReloads((count) => count + 1)
  }

  useEffect(() => {
    if (reloads > 0) view?.reload()
  }, [reloads, view])

  const go = (event: FormEvent) => {
    event.preventDefault()

    const next = addressOf(typed)

    if (next !== null) open(next)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && pick) setPick(false)
  }

  const showsPage = blocked === null && !(address === null && requested === null)

  useEffect(() => {
    showBrowserPage(threadId, showsPage ? slot.current : null)

    return () => showBrowserPage(threadId, null)
  }, [threadId, showsPage])

  const web = webAddress(address)
  const file = showsFile ? fileName(page.path) : null
  const canPick = view !== null && page !== null && blocked === null

  return (
    <SidePanel
      name="Browser"
      heading={title || file || web?.host || "Browser"}
      width={paneWidthAtom}
      onClose={props.onClose}
      actions={
        <>
          {web !== null && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Open in your browser"
              title="Open in your browser"
              onClick={() => window.open(web.href)}
            >
              <ExternalLink aria-hidden />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open DevTools"
            title="Open DevTools"
            disabled={!attached}
            onClick={() => view?.openDevTools()}
          >
            <Bug aria-hidden />
          </Button>
        </>
      }
    >
      <div role="presentation" className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-1 border-b px-3 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Previous page"
            disabled={!history.back}
            onClick={() => view?.goBack()}
          >
            <ArrowLeft aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Next page"
            disabled={!history.forward}
            onClick={() => view?.goForward()}
          >
            <ArrowRight aria-hidden />
          </Button>
          {loading ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Stop loading"
              onClick={() => view?.stop()}
            >
              <X aria-hidden />
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Reload"
              disabled={address === null}
              onClick={() => view?.reload()}
            >
              <RotateCw aria-hidden />
            </Button>
          )}
          <form className="flex min-w-0 flex-1" onSubmit={go}>
            <Input
              aria-label="Address"
              className="h-7 min-w-0 flex-1"
              placeholder={
                policy.local ? "Type an address, like localhost:3000" : "Type an address"
              }
              spellCheck={false}
              ref={addressInput}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </form>
          <Toggle
            variant="outline"
            size="sm"
            pressed={pick}
            disabled={!canPick}
            onPressedChange={setPick}
          >
            <MousePointerClick data-icon="inline-start" aria-hidden />
            Pick element
          </Toggle>
        </div>
        {canPick && (
          <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
            {pick
              ? "Click part of the page to leave a Feedback note. Esc to stop."
              : "Select text, or pick an element, to leave a Feedback note."}
          </p>
        )}
        <div ref={slot} className="relative min-h-0 flex-1">
          {view !== null && page !== null && (
            <PageNotes
              key={`${pageKey(page)} ${loads}`}
              view={view}
              slot={slot}
              threadId={threadId}
              page={page}
              pick={pick}
              loads={loads}
              onStopPicking={() => setPick(false)}
            />
          )}
          {blocked !== null ? (
            <p className="absolute inset-0 bg-background p-5 text-sm text-muted-foreground">
              This Thread's apps run in its Sandbox, so {blocked} would open this device's, not the
              Sandbox's.
            </p>
          ) : (
            address === null &&
            requested === null && (
              <p className="absolute inset-0 bg-background p-5 text-sm text-muted-foreground">
                Type an address to open a page beside this Thread.
              </p>
            )
          )}
        </div>
      </div>
    </SidePanel>
  )
})
