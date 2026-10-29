import { useAtomValue } from "@effect/atom-react"
import type { AskAnswer, AskPlace, PullRequestWorkspace } from "@glass/contracts"
import { Exit } from "effect"
import { Atom, type AtomRegistry } from "effect/reactivity"
import { Backend, backendRuntimeOf, type BackendRuntime } from "./backend"
import { type LineNotePlace, sameLineNotePlaces } from "./changesView"
import { type Problem, problemOf } from "./problems"

export type AskState =
  | { readonly status: "pending" }
  | { readonly status: "answered"; readonly answer: AskAnswer }
  | { readonly status: "failed"; readonly problem: Problem }

export interface AskView {
  readonly key: string
  readonly place: AskPlace
  readonly question: string
  readonly state: AskState
}

const questionsAtom = Atom.family((_pullRequestAndRevision: string) =>
  Atom.make<ReadonlyMap<string, AskView>>(new Map()).pipe(Atom.keepAlive),
)

const settled = ({ state }: AskView) => state.status !== "pending"

/**
 * The questions asked in one PR workspace and their answers, kept in memory for its PR and
 * Revision until Glass quits, even when the workspace itself is opened afresh.
 * Nothing here is feedback: none of it reaches GitHub.
 */
export class AskStore {
  readonly #runtime: BackendRuntime
  readonly #runs = new Map<string, AbortController>()
  readonly #viewsAtom: Atom.Writable<ReadonlyMap<string, AskView>>
  readonly placesAtom = Atom.make((get) =>
    [...get(this.#viewsAtom).values()].map(({ key, place }): LineNotePlace => ({ key, ...place })),
  ).pipe(Atom.withEquality<ReadonlyArray<LineNotePlace>>(sameLineNotePlaces))
  readonly viewAtom = Atom.family((key: string) =>
    Atom.make((get) => get(this.#viewsAtom).get(key)),
  )
  readonly #unmount: () => void

  constructor(
    readonly workspace: PullRequestWorkspace,
    readonly registry: AtomRegistry.AtomRegistry,
  ) {
    const { pullRequest, revision } = workspace
    this.#viewsAtom = questionsAtom(`${pullRequest.url}@${revision.base}..${revision.head}`)
    this.#unmount = registry.mount(this.placesAtom)
    this.#runtime = backendRuntimeOf(registry)
    registry.update(
      this.#viewsAtom,
      (views) => new Map([...views].filter(([, view]) => settled(view))),
    )
  }

  readonly view = (key: string) => this.registry.get(this.#viewsAtom).get(key)

  ask(place: AskPlace, question: string) {
    const trimmed = question.trim()

    if (trimmed === "") return

    this.#run({ key: crypto.randomUUID(), place, question: trimmed })
  }

  retry(key: string) {
    const view = this.view(key)

    if (view?.state.status === "failed") this.#run(view)
  }

  remove(key: string) {
    this.#runs.get(key)?.abort()
    this.#runs.delete(key)
    this.registry.update(this.#viewsAtom, (views) => {
      const next = new Map(views)
      next.delete(key)

      return next
    })
  }

  dispose() {
    for (const run of this.#runs.values()) run.abort()

    this.#runs.clear()
    this.#unmount()
  }

  #run(view: Omit<AskView, "state">) {
    const { key } = view
    const run = new AbortController()
    this.#runs.set(key, run)
    this.#set({ ...view, state: { status: "pending" } })

    const ask = Backend.use((backend) =>
      backend.Ask({
        pullRequest: this.workspace.pullRequest.ref,
        revision: this.workspace.revision,
        place: view.place,
        question: view.question,
      }),
    )

    void this.#runtime.runPromiseExit(ask, { signal: run.signal }).then((exit) => {
      if (this.#runs.get(key) !== run) return

      this.#runs.delete(key)
      const current = this.view(key)

      if (current === undefined) return

      this.#set({
        ...current,
        state: Exit.isSuccess(exit)
          ? { status: "answered", answer: exit.value }
          : { status: "failed", problem: problemOf(exit.cause) },
      })
    })
  }

  #set(view: AskView) {
    this.registry.update(this.#viewsAtom, (views) => new Map(views).set(view.key, view))
  }
}

export const useAsk = (store: AskStore, key: string) => useAtomValue(store.viewAtom(key))

export const useLineAskPlaces = (store: AskStore) => useAtomValue(store.placesAtom)
