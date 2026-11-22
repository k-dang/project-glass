import { type BrowserPageAnswer, BrowserPageReady, BrowserPageRefused } from "@glass/contracts"
import { BROWSER_PARTITION } from "@glass/contracts/desktop"
import { Stream } from "effect"
import { Atom, AsyncResult, type AtomRegistry } from "effect/reactivity"
import { Backend, backendRuntime, backendRuntimeOf } from "./backend"
import {
  agentHeldThreads,
  browserPageReady,
  holdBrowserPage,
  liveBrowserPage,
  releaseBrowserPage,
  remembered,
} from "./browserPages"
import { workingThreadsAtom } from "./threadsArea"

const browserPageRequestsAtom = backendRuntime
  .atom(Stream.unwrap(Backend.useSync((backend) => backend.WatchBrowserPageRequests())))
  .pipe(Atom.keepAlive)

export const browserControlAtom = backendRuntime
  .atom(Stream.unwrap(Backend.useSync((backend) => backend.WatchBrowserControl())))
  .pipe(Atom.keepAlive)

export const answerBrowserPageRequests = (registry: AtomRegistry.AtomRegistry) => {
  const runtime = backendRuntimeOf(registry)
  const answered = new Set<string>()
  const restorations = new WeakMap<HTMLWebViewElement, Promise<void>>()
  const relayed = new Map<number, string>()
  let hearingInput = false

  const reply = (id: string, answer: BrowserPageAnswer) =>
    void runtime.runPromiseExit(
      Backend.use((backend) => backend.AnswerBrowserPageRequest({ id, answer })),
    )

  const takeOver = (webContentsId: number) => {
    const threadId = relayed.get(webContentsId)

    if (threadId === undefined || !agentHeldThreads().includes(threadId)) return

    const controls = AsyncResult.getOrElse(registry.get(browserControlAtom), () => [])

    if (controls.some((control) => control.threadId === threadId && control.userTookOver)) return

    const view = liveBrowserPage(threadId)

    if (view?.isWaitingForResponse() === true) view.stop()

    void runtime.runPromiseExit(Backend.use((backend) => backend.TakeOverBrowser({ threadId })))
  }

  const relayOf = (threadId: string, view: HTMLWebViewElement) => {
    const webContentsId = view.getWebContentsId()
    relayed.set(webContentsId, threadId)

    if (!hearingInput) {
      hearingInput = true
      window.glass.onBrowserUserInput(takeOver)
    }

    return window.glass.browserRelay(webContentsId)
  }

  registry.subscribe(
    browserPageRequestsAtom,
    (requests) => {
      if (!AsyncResult.isSuccess(requests)) return

      for (const id of answered)
        if (!requests.value.some((request) => request.id === id)) answered.delete(id)

      for (const { id, threadId, restoreLastPage } of requests.value) {
        if (answered.has(id)) continue

        answered.add(id)

        const last = liveBrowserPage(threadId) === null ? remembered(threadId) : null
        const view = holdBrowserPage(threadId, "agent", BROWSER_PARTITION)
        const ready = browserPageReady(threadId)

        if (last !== null && restoreLastPage)
          restorations.set(
            view,
            ready.then(() => view.loadURL(last).catch(() => undefined)),
          )

        void (restoreLastPage ? (restorations.get(view) ?? ready) : ready)
          .then(() => relayOf(threadId, view))
          .then(
            (endpoint) => reply(id, BrowserPageReady.make({ endpoint })),
            (cause: Error) => reply(id, BrowserPageRefused.make({ message: cause.message })),
          )
      }
    },
    { immediate: true },
  )

  registry.subscribe(
    workingThreadsAtom,
    (working) => {
      if (!AsyncResult.isSuccess(working)) return

      for (const threadId of agentHeldThreads())
        if (!working.value.has(threadId)) releaseBrowserPage(threadId, "agent")
    },
    { immediate: true },
  )
}
