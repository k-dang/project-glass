import {
  type Activity,
  PullRequestList,
  PullRequestRef,
  type PullRequestWorkspace,
} from "@glass/contracts"
import { linkOptions } from "@tanstack/react-router"
import { Effect, Option, Predicate, Schema, Stream } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity"
import { ActivityRecorder } from "./activity"
import { Backend, backendRuntime, backendRuntimeOf } from "./backend"
import { connectionAtom } from "./connection"
import { reviewedOutAtom, takeReviewedOut } from "./queue"
import { reviewingRevisionAtom } from "./workspaceEvents"
import { WorkspaceFeedback, type ReloadFeedback } from "./workspaceFeedback"
import { savedDestinationsAtom, savedIn } from "./savedPlace"
import { restoreReviewPosition } from "./reviewPosition"
import { watched } from "./watched"

interface OpenWorkspace {
  readonly workspace: PullRequestWorkspace
  readonly activity: ActivityRecorder
  readonly feedback: WorkspaceFeedback
}

export type WorkspaceTab = "overview" | "changes" | "files"

export type ChangesOrder = "path" | "tour"

export interface WorkspaceView {
  readonly tab: WorkspaceTab
  readonly file: string | null
  readonly repositoryFile: string | null
  readonly order: ChangesOrder
}

const withFallback = <A extends string>(schema: Schema.Codec<A>, value: NoInfer<A>) =>
  schema.pipe(
    Schema.catchDecoding(() => Effect.succeedSome(value)),
    Schema.withDecodingDefaultKey(Effect.succeed(value)),
  )

export const ListSearch = Schema.Struct({
  list: withFallback(Schema.Literals([...PullRequestList.literals, "queue"]), "needs-review"),
  view: withFallback(Schema.Literals(["recent", "repository"]), "recent"),
})

export type ListSearch = typeof ListSearch.Type

export type ListView = ListSearch["view"]

export const defaultListSearch = Schema.decodeSync(ListSearch)({})

const PullRequestParams = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  number: Schema.NumberFromString,
}).pipe(Schema.decodeTo(PullRequestRef))

export const decodePullRequestParams = Schema.decodeUnknownOption(PullRequestParams)

export const sameRef = (a: PullRequestRef, b: PullRequestRef) =>
  a.owner === b.owner && a.repo === b.repo && a.number === b.number

const urlOf = (ref: PullRequestRef) =>
  `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`

const conjunction = new Intl.ListFormat("en", { type: "conjunction" })

interface DiscardPrompt {
  readonly description: string
  readonly answer: (discard: boolean) => void
}

export const discardPromptAtom = Atom.make<DiscardPrompt | null>(null).pipe(Atom.keepAlive)

const confirmDiscarding = (
  registry: AtomRegistry.AtomRegistry,
  lost: ReadonlyArray<string>,
): Effect.Effect<boolean> =>
  lost.length === 0
    ? Effect.succeed(true)
    : Effect.callback<boolean>((resume) => {
        const prompt: DiscardPrompt = {
          description: `${conjunction.format(lost)} will be discarded.`,
          answer: (discard) => {
            registry.set(discardPromptAtom, null)
            resume(Effect.succeed(discard))
          },
        }

        registry.get(discardPromptAtom)?.answer(false)
        registry.set(discardPromptAtom, prompt)

        return Effect.sync(() => {
          if (registry.get(discardPromptAtom) === prompt) registry.set(discardPromptAtom, null)
        })
      })

export const listSearchAtom = Atom.make(defaultListSearch).pipe(Atom.keepAlive)

const defaultWorkspaceView: WorkspaceView = {
  tab: "overview",
  file: null,
  repositoryFile: null,
  order: "tour",
}

export const workspaceViewAtom = Atom.make(defaultWorkspaceView).pipe(Atom.keepAlive)

export const resumeNoticeAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive)

export const readAgentReviewOnOpenAtom = Atom.make<string | null>(null)

export const targetAtom = Atom.make<PullRequestRef | null>(null).pipe(Atom.keepAlive)

export const reviewsLinkAtom = Atom.make((get) => {
  const target = get(targetAtom)

  return target === null
    ? linkOptions({ to: "/reviews", search: get(listSearchAtom) })
    : linkOptions({ to: "/reviews/$owner/$repo/$number", params: target })
})

interface OpenRequest {
  readonly ref: PullRequestRef
  readonly loaded?: OpenWorkspace
  readonly previous?: ReloadFeedback
}

const LOADED_TTL = 5 * 60_000

interface Loaded {
  readonly open: OpenWorkspace
  readonly agingSince: number | null
}

const loadedAtom = Atom.make<ReadonlyMap<string, Loaded>>(new Map()).pipe(Atom.keepAlive)

const isFresh = ({ agingSince }: Loaded) =>
  agingSince === null || Date.now() - agingSince < LOADED_TTL

const remember = (registry: AtomRegistry.AtomRegistry, ref: PullRequestRef, open: OpenWorkspace) =>
  registry.update(loadedAtom, (loaded) => {
    const target = registry.get(targetAtom)
    const shown = target === null ? null : urlOf(target)

    const kept = (url: string, entry: Loaded) =>
      url !== urlOf(ref) && (url === shown || isFresh(entry))

    const next = new Map(loaded)

    for (const [url, entry] of loaded) {
      if (kept(url, entry)) continue

      entry.open.feedback.dispose()

      next.delete(url)
    }

    next.set(urlOf(ref), { open, agingSince: Date.now() })

    return next
  })

const recall = (registry: AtomRegistry.AtomRegistry, ref: PullRequestRef) => {
  const loaded = registry.get(loadedAtom).get(urlOf(ref))

  return loaded !== undefined && isFresh(loaded) ? loaded.open : undefined
}

export const openWorkspaceAtom = backendRuntime
  .fn((request: OpenRequest, get) =>
    Effect.gen(function* () {
      const destination = yield* AtomRegistry.getResult(get.registry, savedDestinationsAtom).pipe(
        Effect.map((destinations) => savedIn(destinations, "reviews")),
        Effect.catch(() => Effect.succeed(undefined)),
      )

      const open =
        request.loaded ??
        (yield* get
          .stream(connectionAtom)
          .pipe(
            Stream.filter(AsyncResult.isSuccess),
            Stream.runHead,
            Effect.andThen(load(request, get.registry)),
          ))

      void open.activity
        .opened()
        .finally(() => get.registry.update(reviewingRevisionAtom, (revision) => revision + 1))

      if (destination !== undefined && request.previous === undefined) {
        const restored = restoreReviewPosition(open.workspace, destination)

        if (restored.view !== null) get.set(workspaceViewAtom, restored.view)

        get.set(resumeNoticeAtom, restored.notice)
      }

      return open
    }),
  )
  .pipe(Atom.keepAlive)

export const changedOnGitHubAtom = watched(
  backendRuntime.atom((get) => {
    const open = get(openWorkspaceAtom)
    const workspace = Option.getOrNull(AsyncResult.value(open))?.workspace

    if (workspace === undefined || open.waiting) return Effect.succeed(null)

    const previouslyChanged = get
      .self<AsyncResult.AsyncResult<PullRequestWorkspace | null>>()
      .pipe(Option.flatMap(AsyncResult.value), Option.getOrNull)

    if (previouslyChanged === workspace) return Effect.succeed(workspace)

    return Backend.use((backend) =>
      backend.HasPullRequestChanged({
        pullRequestId: workspace.pullRequest.id,
        revision: workspace.revision,
        updatedAt: workspace.updatedAt,
      }),
    ).pipe(Effect.map((changed) => (changed ? workspace : null)))
  }),
)

const load = (request: OpenRequest, registry: AtomRegistry.AtomRegistry) =>
  Backend.use((backend) => backend.LoadPullRequest({ pullRequest: request.ref })).pipe(
    Effect.map((workspace) => {
      const open = build(workspace, request.previous, registry)

      remember(registry, request.ref, open)

      return open
    }),
  )

const setAgingSince = (
  registry: AtomRegistry.AtomRegistry,
  ref: PullRequestRef,
  agingSince: number | null,
) =>
  registry.update(loadedAtom, (loaded) => {
    const entry = loaded.get(urlOf(ref))

    return entry === undefined ? loaded : new Map(loaded).set(urlOf(ref), { ...entry, agingSince })
  })

export const preloadAtom = Atom.family((ref: PullRequestRef) =>
  backendRuntime.atom((get) => {
    get.addFinalizer(() => setAgingSince(get.registry, ref, Date.now()))

    const loaded =
      recall(get.registry, ref) === undefined
        ? load({ ref }, get.registry).pipe(Effect.asVoid)
        : Effect.void

    return loaded.pipe(Effect.andThen(Effect.sync(() => setAgingSince(get.registry, ref, null))))
  }),
)

export const openPullRequest = (registry: AtomRegistry.AtomRegistry, ref: PullRequestRef) => {
  const target = registry.get(targetAtom)

  if (target !== null && sameRef(target, ref)) return

  registry.set(targetAtom, ref)
  registry.set(reviewedOutAtom, null)
  registry.set(workspaceViewAtom, defaultWorkspaceView)
  registry.set(resumeNoticeAtom, null)
  registry.set(openWorkspaceAtom, Atom.Reset)

  const loaded = recall(registry, ref)

  if (loaded === undefined) return registry.set(openWorkspaceAtom, { ref })

  registry.set(openWorkspaceAtom, { ref, loaded })
}

export const retryOpen = (registry: AtomRegistry.AtomRegistry) => {
  const target = registry.get(targetAtom)

  if (target !== null) registry.set(openWorkspaceAtom, { ref: target })
}

export const reloadPullRequest = async (registry: AtomRegistry.AtomRegistry) => {
  const target = registry.get(targetAtom)
  const current = Option.getOrNull(AsyncResult.value(registry.get(openWorkspaceAtom)))

  if (target === null || current === null) return

  const cancellation = new AbortController()
  const stop = registry.subscribe(targetAtom, () => cancellation.abort())

  try {
    await Effect.runPromiseExit(
      current.feedback.prepareReload(
        (lost) => confirmDiscarding(registry, lost),
        (previous) =>
          Effect.gen(function* () {
            registry.set(openWorkspaceAtom, { ref: target, previous })
            yield* AtomRegistry.getResult(registry, openWorkspaceAtom, { suspendOnWaiting: true })
          }),
      ),
      { signal: cancellation.signal },
    )
  } finally {
    stop()
  }
}

export const leavesPullRequest = (
  registry: AtomRegistry.AtomRegistry,
  next: { readonly routeId: string; readonly params: unknown },
) => {
  const target = registry.get(targetAtom)

  if (target === null) return false

  if (next.routeId === "/reviews/") return true

  return (
    next.routeId === "/reviews/$owner/$repo/$number" &&
    Option.exists(decodePullRequestParams(next.params), (ref) => !sameRef(ref, target))
  )
}

export const confirmLeave = async (registry: AtomRegistry.AtomRegistry) => {
  const current = Option.getOrNull(AsyncResult.value(registry.get(openWorkspaceAtom)))

  if (current === null) return true

  return Effect.runPromise(
    current.feedback.prepareLeave((lost) => confirmDiscarding(registry, lost)),
  )
}

export const closePullRequest = (registry: AtomRegistry.AtomRegistry) => {
  registry.set(targetAtom, null)
  registry.set(reviewedOutAtom, null)
  registry.set(openWorkspaceAtom, Atom.Reset)
}

const build = (
  workspace: PullRequestWorkspace,
  previous: OpenRequest["previous"],
  registry: AtomRegistry.AtomRegistry,
): OpenWorkspace => {
  const runtime = backendRuntimeOf(registry)
  const activity = new ActivityRecorder(workspace, runtime)

  const record = (recorded: Activity) => {
    activity.record(recorded)

    if (Predicate.isTagged(recorded, "ReviewSubmitted"))
      takeReviewedOut(registry, workspace.pullRequest.ref)
  }

  return {
    workspace,
    activity,
    feedback: new WorkspaceFeedback(workspace, registry, record, previous),
  }
}
