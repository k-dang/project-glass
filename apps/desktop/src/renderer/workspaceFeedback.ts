import type { Activity, PullRequestWorkspace } from "@glass/contracts"
import { Effect } from "effect"
import type { AtomRegistry } from "effect/reactivity"
import { activityPullRequest } from "./activity"
import { AskStore } from "./useAsks"
import { DraftStore } from "./useDrafts"
import { createReactions, type Reactions } from "./useReactions"
import { ReplyStore } from "./useReplies"
import { createResolutions, type Resolutions } from "./useResolutions"
import { ViewedFilesStore } from "./useViewedFiles"

type ConfirmDiscard = (lost: ReadonlyArray<string>) => Effect.Effect<boolean>

export interface ReloadFeedback {
  readonly replies: ReadonlyMap<string, string>
  readonly summary: string
}

interface Hold {
  lock(): Promise<void>
  unlock(): void
}

export class WorkspaceFeedback {
  readonly drafts: DraftStore
  readonly asks: AskStore
  readonly replies: ReplyStore
  readonly resolutions: Resolutions
  readonly reactions: Reactions
  readonly viewedFiles: ViewedFilesStore
  #disposed = false

  constructor(
    workspace: PullRequestWorkspace,
    registry: AtomRegistry.AtomRegistry,
    record: (activity: Activity) => void,
    previous?: ReloadFeedback,
  ) {
    const { onLines, outdated } = workspace.discussions
    const ids = new Set([...onLines, ...outdated].map((discussion) => discussion.id))
    const replies = [...(previous?.replies ?? [])].filter(([id]) => ids.has(id))

    this.drafts = new DraftStore(workspace, registry, record, previous?.summary)
    this.asks = new AskStore(workspace, registry)
    this.replies = new ReplyStore(
      registry,
      activityPullRequest(workspace),
      record,
      new Map(replies),
    )
    this.resolutions = createResolutions(registry)
    this.reactions = createReactions(registry)
    this.viewedFiles = new ViewedFilesStore(workspace, registry)
  }

  prepareReload<E, R>(
    confirm: ConfirmDiscard,
    replace: (previous: ReloadFeedback) => Effect.Effect<void, E, R>,
  ): Effect.Effect<void, E, R> {
    return Effect.suspend(() => {
      if (this.#disposed || this.drafts.locked()) return Effect.void

      const drafts = this.drafts

      return this.#handOff(
        [drafts, this.replies, this.viewedFiles, this.resolutions, this.reactions],
        () => this.#lostDrafts(),
        confirm,
        Effect.suspend(() =>
          replace({
            replies: this.replies.unsent(),
            get summary() {
              return drafts.summary()
            },
          }),
        ),
      )
    })
  }

  prepareLeave(confirm: ConfirmDiscard): Effect.Effect<boolean> {
    return this.#handOff(
      [this.drafts, this.replies],
      () => [
        ...this.#lostDrafts(),
        ...(this.replies.unsent().size > 0 ? ["Replies you haven't published"] : []),
        ...(this.drafts.summary().trim() !== "" ? ["your Review summary"] : []),
      ],
      confirm,
      Effect.sync(() => {
        this.drafts.discardUnsaved()
        this.replies.discardUnsaved()
        this.viewedFiles.discardUnsaved()
      }),
    )
  }

  #handOff<E, R>(
    holds: ReadonlyArray<Hold>,
    lost: () => ReadonlyArray<string>,
    confirm: ConfirmDiscard,
    proceed: Effect.Effect<void, E, R>,
  ): Effect.Effect<boolean, E, R> {
    return Effect.acquireUseRelease(
      Effect.sync(() => Promise.all(holds.map((hold) => hold.lock()))),
      (drained) =>
        Effect.gen({ self: this }, function* () {
          yield* Effect.promise(() => drained)

          const proceeding = yield* confirm(lost())

          if (proceeding) yield* proceed

          return proceeding
        }),
      () =>
        Effect.sync(() => {
          if (this.#disposed) return

          for (const hold of holds) hold.unlock()
        }),
    )
  }

  #lostDrafts() {
    return this.drafts.hasUnsaved() ? ["Drafts that couldn't save to GitHub"] : []
  }

  dispose() {
    this.#disposed = true
    this.drafts.dispose()
    this.asks.dispose()
    this.replies.dispose()
    this.resolutions.dispose()
    this.reactions.dispose()
    this.viewedFiles.dispose()
  }
}
