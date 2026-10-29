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

  readonly view = (discussionId: string) =>
    this.registry.get(this.viewsAtom).get(discussionId) ?? empty

  readonly locked = () => this.registry.get(this.lockedAtom)

  edit(discussionId: string, body: string) {
    const view = this.view(discussionId)

    if (this.locked() || view.feedback?.type === "sending") return

    this.#set(discussionId, { ...view, body, feedback: null })
  }

  send(discussionId: string) {
    const view = this.view(discussionId)
    const { body } = view

    if (this.locked() || view.feedback?.type === "sending" || body.trim() === "") return

    this.#set(discussionId, { ...view, feedback: { type: "sending" } })

    const reply = Backend.use((backend) => backend.ReplyToDiscussion({ discussionId, body }))

    const done = this.#runtime.runPromiseExit(reply).then((exit) => {
      this.#calls.delete(done)
      const { published } = this.view(discussionId)

      if (Exit.isSuccess(exit))
        this.#record(ReplySent.make({ pullRequest: this.#pullRequest, discussionId, body }))

      this.#set(
        discussionId,
        Exit.isSuccess(exit)
          ? { body: "", feedback: null, published: [...published, exit.value] }
          : { body, feedback: { type: "failed", problem: problemOf(exit.cause) }, published },
      )
    })

    this.#calls.add(done)
  }

  async lock(): Promise<ReadonlyMap<string, string>> {
    this.#holds += 1
    this.registry.set(this.lockedAtom, this.#holds > 0)

    while (this.#calls.size > 0) await Promise.all(this.#calls)

    return new Map(
      [...this.registry.get(this.viewsAtom)].flatMap(([id, { body }]) =>
        body.trim() === "" ? [] : [[id, body]],
      ),
    )
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

  #set(discussionId: string, view: ReplyView) {
    this.registry.update(this.viewsAtom, (views) => new Map(views).set(discussionId, view))
  }
}

export const useReply = (store: ReplyStore, discussionId: string) =>
  useAtomValue(store.viewsAtom, (views) => views.get(discussionId) ?? empty)

export const usePublishedReplies = (store: ReplyStore, discussionId: string) =>
  useAtomValue(store.viewsAtom, (views) => (views.get(discussionId) ?? empty).published)

export const useRepliesLocked = (store: ReplyStore) => useAtomValue(store.lockedAtom)
