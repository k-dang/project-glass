import {
  type PullRequestRef,
  type QueueAddition,
  type QueuedPullRequest,
  referenceKey,
} from "@glass/contracts"
import { Effect, Exit, Option } from "effect"
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity"
import { toast } from "@/components/ui/toast"
import { Backend, type BackendError, backendRuntime, backendRuntimeOf } from "./backend"
import { problemOf, problemText } from "./problems"
import { watched } from "./watched"
import { reviewingRevisionAtom } from "./workspaceEvents"

export const savedQueueAtom = backendRuntime
  .atom((get) => {
    get(reviewingRevisionAtom)

    return Backend.use((backend) => backend.ListSavedQueue())
  })
  .pipe(Atom.keepAlive)

export const reviewedOutAtom = Atom.make<{
  readonly ref: PullRequestRef
  readonly position: number
} | null>(null).pipe(Atom.keepAlive)

export const takeReviewedOut = (registry: AtomRegistry.AtomRegistry, ref: PullRequestRef) => {
  const entries = Option.getOrElse(AsyncResult.value(registry.get(savedQueueAtom)), () => [])

  const position = entries.findIndex(
    (queued) => referenceKey(queued.pullRequest.ref) === referenceKey(ref),
  )

  if (position !== -1) registry.set(reviewedOutAtom, { ref, position })

  registry.refresh(savedQueueAtom)
}

const reread = (registry: AtomRegistry.AtomRegistry) =>
  Effect.sync(() => registry.refresh(savedQueueAtom))

export const queueRefreshAtom = watched(
  backendRuntime
    .atom((get) =>
      Backend.use((backend) => backend.RefreshQueue()).pipe(Effect.andThen(reread(get.registry))),
    )
    .pipe(Atom.setIdleTTL("5 minutes")),
)

export const watchedQueueAtom = Atom.make((get) => {
  get(queueRefreshAtom)

  return get(savedQueueAtom)
})

export const addToQueueAtom = backendRuntime.fn((references: ReadonlyArray<PullRequestRef>, get) =>
  Backend.use((backend) => backend.AddToQueue({ references })).pipe(
    Effect.tap(reread(get.registry)),
  ),
)

export const referenceText = ({ owner, repo, number }: PullRequestRef) =>
  `${owner}/${repo}#${number}`

const conjunction = new Intl.ListFormat("en", { type: "conjunction" })

export const describeAddition = ({ added, alreadyQueued, notFound }: QueueAddition) => {
  const already =
    alreadyQueued.length === 0
      ? []
      : [
          added.length === 0 && notFound.length === 0
            ? "Already queued"
            : `${alreadyQueued.length} already queued`,
        ]

  const missing =
    notFound.length === 0
      ? []
      : [`Couldn't find ${conjunction.format(notFound.map(referenceText))}`]

  return [...already, ...missing].join(" · ")
}

const change = async <A>(
  registry: AtomRegistry.AtomRegistry,
  call: (backend: Backend["Service"]) => Effect.Effect<A, BackendError>,
  failed: string,
) => {
  const exit = await backendRuntimeOf(registry).runPromiseExit(
    Backend.use(call).pipe(Effect.tap(reread(registry))),
  )

  if (Exit.isSuccess(exit)) return exit.value

  toast.add({ type: "error", title: failed, description: problemText(problemOf(exit.cause)) })

  return null
}

export const removeFromQueue = async (
  registry: AtomRegistry.AtomRegistry,
  reference: PullRequestRef,
) => {
  const removed = await change(
    registry,
    (backend) => backend.RemoveFromQueue({ reference }),
    `Couldn't remove ${referenceText(reference)}`,
  )

  if (removed === null) return

  toast.add({
    type: "info",
    title: `Removed ${referenceText(removed.pullRequest.ref)} from the Queue`,
    actionProps: { children: "Undo", onClick: () => void restore(registry, removed) },
  })
}

const restore = (registry: AtomRegistry.AtomRegistry, queued: QueuedPullRequest) =>
  change(
    registry,
    (backend) => backend.RestoreToQueue({ queued }),
    `Couldn't put ${referenceText(queued.pullRequest.ref)} back`,
  )
