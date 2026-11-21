import { useAtomValue } from "@effect/atom-react"
import {
  type Activity,
  type ActivityPullRequest,
  type PublishedComment,
  ReplySent,
} from "@glass/contracts"
import { Exit } from "effect"
import { Atom, type AtomRegistry } from "effect/reactivity"
import { Backend, backendRuntimeOf, type BackendRuntime } from "./backend"
import { type Problem, problemOf } from "./problems"

export type ReplyFeedback =
  | { readonly type: "sending" }
  | { readonly type: "failed"; readonly problem: Problem }
  | null

export interface ReplyView {
  readonly body: string
  readonly feedback: ReplyFeedback
  readonly published: ReadonlyArray<PublishedComment>
}

const empty: ReplyView = { body: "", feedback: null, published: [] }

export class ReplyStore {
  readonly #runtime: BackendRuntime
  readonly #pullRequest: ActivityPullRequest
  readonly #record: (activity: Activity) => void
  readonly viewsAtom = Atom.make<ReadonlyMap<string, ReplyView>>(new Map())
  readonly lockedAtom = Atom.make(false)
  readonly #calls = new Set<Promise<void>>()
  readonly dispose: () => void
  #holds = 0

  constructor(
    readonly registry: AtomRegistry.AtomRegistry,
    pullRequest: ActivityPullRequest,
    record: (activity: Activity) => void,
    unsent: ReadonlyMap<string, string> = new Map(),
  ) {
    this.dispose = registry.mount(
      Atom.make((get) => {
        get(this.viewsAtom)
        get(this.lockedAtom)
      }),
    )
    this.#runtime = backendRuntimeOf(registry)
    this.#pullRequest = pullRequest
    this.#record = record

    registry.set(this.viewsAtom, new Map([...unsent].map(([id, body]) => [id, { ...empty, body }])))
  }

  readonly view = (reviewThreadId: string) =>
    this.registry.get(this.viewsAtom).get(reviewThreadId) ?? empty

  readonly locked = () => this.registry.get(this.lockedAtom)

  edit(reviewThreadId: string, body: string) {
    const view = this.view(reviewThreadId)

    if (this.locked() || view.feedback?.type === "sending") return

    this.#set(reviewThreadId, { ...view, body, feedback: null })
  }

  send(reviewThreadId: string) {
    const view = this.view(reviewThreadId)
    const { body } = view

    if (this.locked() || view.feedback?.type === "sending" || body.trim() === "") return

    this.#set(reviewThreadId, { ...view, feedback: { type: "sending" } })

    const reply = Backend.use((backend) => backend.ReplyToReviewThread({ reviewThreadId, body }))

    const done = this.#runtime.runPromiseExit(reply).then((exit) => {
      this.#calls.delete(done)
      const { published } = this.view(reviewThreadId)

      if (Exit.isSuccess(exit))
        this.#record(ReplySent.make({ pullRequest: this.#pullRequest, reviewThreadId, body }))

      this.#set(
        reviewThreadId,
        Exit.isSuccess(exit)
          ? { body: "", feedback: null, published: [...published, exit.value] }
          : { body, feedback: { type: "failed", problem: problemOf(exit.cause) }, published },
      )
    })

    this.#calls.add(done)
  }

  unsent(): ReadonlyMap<string, string> {
    return new Map(
      [...this.registry.get(this.viewsAtom)].flatMap(([id, { body }]) =>
        body.trim() === "" ? [] : [[id, body]],
      ),
    )
  }

  async lock() {
    this.#holds += 1
    this.registry.set(this.lockedAtom, this.#holds > 0)

    while (this.#calls.size > 0) await Promise.all(this.#calls)
  }

  discardUnsaved() {
    this.registry.update(
      this.viewsAtom,
      (views) => new Map([...views].map(([id, { published }]) => [id, { ...empty, published }])),
    )
  }

  unlock() {
    this.#holds -= 1
    this.registry.set(this.lockedAtom, this.#holds > 0)
  }

  #set(reviewThreadId: string, view: ReplyView) {
    this.registry.update(this.viewsAtom, (views) => new Map(views).set(reviewThreadId, view))
  }
}

export const useReply = (store: ReplyStore, reviewThreadId: string) =>
  useAtomValue(store.viewsAtom, (views) => views.get(reviewThreadId) ?? empty)

export const usePublishedReplies = (store: ReplyStore, reviewThreadId: string) =>
  useAtomValue(store.viewsAtom, (views) => (views.get(reviewThreadId) ?? empty).published)

export const useRepliesLocked = (store: ReplyStore) => useAtomValue(store.lockedAtom)
