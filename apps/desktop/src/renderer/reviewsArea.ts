import {
  type Activity,
  PullRequestList,
  PullRequestRef,
  type PullRequestWorkspace,
} from "@glass/contracts"
import { linkOptions } from "@tanstack/react-router"
import { Effect, Option, Predicate, Schema, Stream } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity"
import { ActivityRecorder, activityPullRequest } from "./activity"
import { Backend, backendRuntime, backendRuntimeOf } from "./backend"
import { connectionAtom } from "./connection"
import { reviewedOutAtom, takeReviewedOut } from "./queue"
import { AskStore } from "./useAsks"
import { DraftStore } from "./useDrafts"
import { reviewingRevisionAtom } from "./workspaceEvents"
import { ReplyStore } from "./useReplies"
import { createResolutions, type Resolutions } from "./useResolutions"
import { ViewedFilesStore } from "./useViewedFiles"
import { savedDestinationsAtom, savedIn } from "./savedPlace"
import { restoreReviewPosition } from "./reviewPosition"
import { watched } from "./watched"

interface OpenWorkspace {
  readonly workspace: PullRequestWorkspace
  readonly activity: ActivityRecorder
  readonly drafts: DraftStore
  readonly asks: AskStore
  readonly replies: ReplyStore
  readonly resolutions: Resolutions
  readonly viewedFiles: ViewedFilesStore
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

const confirmDiscarding = async (
  registry: AtomRegistry.AtomRegistry,
  lost: ReadonlyArray<string>,
) =>
  lost.length === 0 ||
  new Promise<boolean>((resolve) => {
    registry.set(discardPromptAtom, {
      description: `${conjunction.format(lost)} will be discarded.`,
      answer: (discard) => {
        registry.set(discardPromptAtom, null)
        resolve(discard)
      },
    })
  })

const unsavedDrafts = "Drafts that couldn't save to GitHub"

const lock = async (open: OpenWorkspace) => {
  const [, unsent] = await Promise.all([open.drafts.lockAndSave(), open.replies.lock()])

  return unsent
}

const discardUnsaved = (open: OpenWorkspace) => {
  open.drafts.discardUnsaved()
  open.replies.discardUnsaved()
  open.viewedFiles.discardUnsaved()
}

const unlock = (open: OpenWorkspace) => {
  open.drafts.unlock()
  open.replies.unlock()
}

export const listSearchAtom = Atom.make(defaultListSearch).pipe(Atom.keepAlive)

const defaultWorkspaceView: WorkspaceView = {
  tab: "overview",
  file: null,
  repositoryFile: null,
  order: "tour",
}

export const workspaceViewAtom = Atom.make(defaultWorkspaceView).pipe(Atom.keepAlive)

export const resumeNoticeAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive)

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
  readonly previous?: {
    readonly open: OpenWorkspace
    readonly replies: ReadonlyMap<string, string>
  }
}

const LOADED_TTL = 5 * 60_000

interface Loaded {
  readonly open: OpenWorkspace
  readonly at: number
}

const loadedAtom = Atom.make<ReadonlyMap<string, Loaded>>(new Map()).pipe(Atom.keepAlive)

const isFresh = (loaded: Loaded) => Date.now() - loaded.at < LOADED_TTL

const remember = (registry: AtomRegistry.AtomRegistry, ref: PullRequestRef, open: OpenWorkspace) =>
  registry.update(loadedAtom, (loaded) => {
    const next = new Map(loaded)

    for (const [url, entry] of loaded) {
      if (url !== urlOf(ref) && isFresh(entry)) continue

      entry.open.drafts.dispose()
      entry.open.asks.dispose()
      entry.open.replies.dispose()
      entry.open.viewedFiles.dispose()

      entry.open.resolutions.dispose()

      next.delete(url)
    }

    next.set(urlOf(ref), { open, at: Date.now() })

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
  Backend.use((backend) => backend.OpenPullRequest({ pullRequest: request.ref })).pipe(
    Effect.map((workspace) => {
      const open = build(workspace, request.previous, registry)

      remember(registry, request.ref, open)

      registry.update(reviewingRevisionAtom, (revision) => revision + 1)

      return open
    }),
    Effect.onError(() =>
      Effect.sync(() => {
        if (request.previous !== undefined) {
          unlock(request.previous.open)
          request.previous.open.viewedFiles.unlock()
          request.previous.open.resolutions.unlock()
        }
      }),
    ),
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

  if (target === null || current === null || current.drafts.locked()) return

  let cancelled = false
  let loading = false
  const targetChanged = Promise.withResolvers<void>()

  const stop = registry.subscribe(targetAtom, () => {
    cancelled = true
    targetChanged.resolve()
  })

  try {
    const saved = await Promise.race([
      Promise.all([lock(current), current.viewedFiles.lock(), current.resolutions.lock()]),
      targetChanged.promise,
    ])

    if (saved === undefined || cancelled || registry.get(targetAtom) !== target) return

    const discard = await Promise.race([
      confirmDiscarding(registry, current.drafts.hasUnsaved() ? [unsavedDrafts] : []),
      targetChanged.promise,
    ])

    if (!discard || cancelled || registry.get(targetAtom) !== target) return

    registry.set(openWorkspaceAtom, {
      ref: target,
      previous: { open: current, replies: saved[0] },
    })
    loading = true
  } finally {
    stop()

    if (!loading) {
      unlock(current)
      current.viewedFiles.unlock()
      current.resolutions.unlock()
    }
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

  const unsent = await lock(current)
  const lost: Array<string> = []

  if (current.drafts.hasUnsaved()) lost.push(unsavedDrafts)

  if (unsent.size > 0) lost.push("Replies you haven't published")

  if (current.drafts.summary().trim() !== "") lost.push("your Review summary")

  const leaving = await confirmDiscarding(registry, lost)

  if (leaving) discardUnsaved(current)

  unlock(current)

  return leaving
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
  const { onLines, outdated } = workspace.discussions
  const ids = new Set([...onLines, ...outdated].map((discussion) => discussion.id))
  const replies = [...(previous?.replies ?? [])].filter(([id]) => ids.has(id))

  const record = (recorded: Activity) => {
    activity.record(recorded)

    if (Predicate.isTagged(recorded, "ReviewSubmitted"))
      takeReviewedOut(registry, workspace.pullRequest.ref)
  }

  return {
    workspace,
    activity,
    drafts: new DraftStore(workspace, registry, record, previous?.open.drafts.summary()),
    asks: new AskStore(workspace, registry),
    replies: new ReplyStore(
      registry,
      activityPullRequest(workspace),
      activity.record,
      new Map(replies),
    ),
    resolutions: createResolutions(registry),
    viewedFiles: new ViewedFilesStore(workspace, registry),
  }
}
