import type { Activity, PullRequestWorkspace } from "@glass/contracts"
import { Effect } from "effect"
import type { AtomRegistry } from "effect/reactivity"
import { activityPullRequest } from "./activity"
import { AskStore } from "./useAsks"
import { DraftStore } from "./useDrafts"
import { ReplyStore } from "./useReplies"
import { createResolutions, type Resolutions } from "./useResolutions"
import { ViewedFilesStore } from "./useViewedFiles"

type ConfirmDiscard = (lost: ReadonlyArray<string>) => Effect.Effect<boolean>

export interface ReloadFeedback {
  readonly replies: ReadonlyMap<string, string>
  readonly summary: string
}

const unsavedDrafts = "Drafts that couldn't save to GitHub"

export class WorkspaceFeedback {
  readonly drafts: DraftStore
  readonly asks: AskStore
  readonly replies: ReplyStore
  readonly resolutions: Resolutions
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
    this.viewedFiles = new ViewedFilesStore(workspace, registry)
  }

  prepareReload<E, R>(
    confirm: ConfirmDiscard,
    replace: (previous: ReloadFeedback) => Effect.Effect<void, E, R>,
  ): Effect.Effect<void, E, R> {
    return Effect.suspend(() => {
      if (this.#disposed || this.drafts.locked()) return Effect.void

      return Effect.acquireUseRelease(
        Effect.sync(() =>
          Promise.all([
            this.drafts.lockAndSave(),
            this.replies.lock(),
            this.viewedFiles.lock(),
            this.resolutions.lock(),
          ]),
        ),
        (pending) =>
          Effect.gen({ self: this }, function* () {
            const [, replies] = yield* Effect.promise(() => pending)

            if (!(yield* confirm(this.drafts.hasUnsaved() ? [unsavedDrafts] : []))) return

            const drafts = this.drafts

            yield* replace({
              replies,
              get summary() {
                return drafts.summary()
              },
            })
          }),
        () =>
          Effect.sync(() => {
            if (this.#disposed) return

            this.drafts.unlock()
            this.replies.unlock()
            this.viewedFiles.unlock()
            this.resolutions.unlock()
          }),
      )
    })
  }

  prepareLeave(confirm: ConfirmDiscard): Effect.Effect<boolean> {
    return Effect.acquireUseRelease(
      Effect.sync(() => Promise.all([this.drafts.lockAndSave(), this.replies.lock()])),
      (pending) =>
        Effect.gen({ self: this }, function* () {
          const [, replies] = yield* Effect.promise(() => pending)
          const lost: Array<string> = []

          if (this.drafts.hasUnsaved()) lost.push(unsavedDrafts)

          if (replies.size > 0) lost.push("Replies you haven't published")

          if (this.drafts.summary().trim() !== "") lost.push("your Review summary")

          const leaving = yield* confirm(lost)

          if (leaving) this.#discardUnsaved()

          return leaving
        }),
      () =>
        Effect.sync(() => {
          if (this.#disposed) return

          this.drafts.unlock()
          this.replies.unlock()
        }),
    )
  }

  #discardUnsaved() {
    this.drafts.discardUnsaved()
    this.replies.discardUnsaved()
    this.viewedFiles.discardUnsaved()
  }

  dispose() {
    this.#disposed = true
    this.drafts.dispose()
    this.asks.dispose()
    this.replies.dispose()
    this.resolutions.dispose()
    this.viewedFiles.dispose()
  }
}
