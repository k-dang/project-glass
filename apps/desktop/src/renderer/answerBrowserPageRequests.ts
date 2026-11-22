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

export const answerBrowserPageRequests = (registry: AtomRegistry.AtomRegistry) => {
  const runtime = backendRuntimeOf(registry)
  const answered = new Set<string>()

  const reply = (id: string, answer: BrowserPageAnswer) =>
    void runtime.runPromiseExit(
      Backend.use((backend) => backend.AnswerBrowserPageRequest({ id, answer })),
    )

  registry.subscribe(
    browserPageRequestsAtom,
    (requests) => {
      if (!AsyncResult.isSuccess(requests)) return

      for (const id of answered)
        if (!requests.value.some((request) => request.id === id)) answered.delete(id)

      for (const { id, threadId } of requests.value) {
        if (answered.has(id)) continue

        answered.add(id)

        const restoring = liveBrowserPage(threadId) === null ? remembered(threadId) : null
        const view = holdBrowserPage(threadId, "agent", BROWSER_PARTITION)

        void browserPageReady(threadId)
          .then(() =>
            restoring === null ? undefined : view.loadURL(restoring).catch(() => undefined),
          )
          .then(() => window.glass.browserRelay(view.getWebContentsId()))
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
