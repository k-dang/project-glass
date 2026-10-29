import { useAtomValue } from "@effect/atom-react"
import {
  type Activity,
  type DiffSide,
  Draft,
  type DraftPlace,
  LinePlace,
  type PullRequestWorkspace,
  type ReviewDecision,
  ReviewSubmitted,
} from "@glass/contracts"
import { Cause, Effect, Exit, Option, Predicate } from "effect"
import { Atom, type AtomRegistry } from "effect/reactivity"
import { activityPullRequest } from "./activity"
import { Backend, backendRuntimeOf, type BackendError, type BackendRuntime } from "./backend"
import { type LineNotePlace, sameLineNotePlaces } from "./changesView"
import { type Problem, problemOf } from "./problems"

type DraftAction = "save" | "delete"

export type Feedback =
  | { readonly type: "draft" }
  | { readonly type: "unsaved" }
  | { readonly type: "sending"; readonly action: DraftAction }
  | { readonly type: "failed"; readonly action: DraftAction; readonly problem: Problem }
  | null

export interface DraftView {
  readonly key: string
  readonly path: string
  readonly place: DraftPlace
  readonly body: string
  readonly feedback: Feedback
  readonly deleting: boolean
  readonly published: boolean
  /** GitHub has never seen this Draft, so dropping it touches nothing there. */
  readonly local: boolean
}

export type SubmitOutcome =
  | { readonly type: "submitted"; readonly published: number }
  | { readonly type: "failed"; readonly problem: Problem }

export type Submission =
  | { readonly type: "idle" | "sending" }
  | Extract<SubmitOutcome, { readonly type: "failed" }>

const idle: Submission = { type: "idle" }

const unsavedProblem: Problem = {
  title: "Some Drafts haven't saved to GitHub",
  detail: "Retry or delete them, then submit your Review.",
}

const mayHaveSubmittedProblem: Problem = {
  title: "Glass lost track of the Review",
  detail: "GitHub may have taken it. Reload to see whether it did before submitting again.",
  fixedByReload: true,
}

const submitProblem = (cause: Cause.Cause<BackendError>) =>
  Option.match(Cause.findErrorOption(cause), {
    onSome: (error) =>
      Predicate.isTagged(error, "GitHubUnavailable") || Predicate.isTagged(error, "RpcClientError")
        ? mayHaveSubmittedProblem
        : problemOf(cause),
    onNone: () => mayHaveSubmittedProblem,
  })

interface Saved {
  readonly id: string
  readonly body: string
}

interface Call {
  readonly action: DraftAction
  readonly run: Effect.Effect<Saved | null, BackendError, Backend>
}

interface Entry {
  readonly key: string
  readonly path: string
  readonly place: DraftPlace
  readonly body: string
  readonly saved: Saved | null
  readonly sending: DraftAction | null
  /** The user asked for this text on GitHub and no call has carried it yet. */
  readonly requested: boolean
  readonly deleting: boolean
  readonly failure: { readonly action: DraftAction; readonly problem: Problem } | null
  readonly published: boolean
}

const pendingAction = (entry: Entry): DraftAction | null => {
  const { saved, body } = entry

  if (entry.deleting || body.trim() === "") return saved === null ? null : "delete"

  if (saved !== null) return body === saved.body ? null : "save"

  return Predicate.isTagged(entry.place, "LinePlace") ? "save" : null
}

// While a call is out, `saved` is stale, so only its landing can tell whether another is needed.
const mayNeedCall = (entry: Entry) => entry.sending !== null || pendingAction(entry) !== null

const feedbackOf = (entry: Entry): Feedback => {
  if (entry.failure !== null) return { type: "failed", ...entry.failure }

  if (entry.sending !== null) return { type: "sending", action: entry.sending }

  if (pendingAction(entry) !== null) return { type: "unsaved" }

  return entry.saved === null ? null : { type: "draft" }
}

const isLocal = (entry: Entry) => entry.saved === null && entry.sending === null

const toView = (entry: Entry): DraftView => ({
  key: entry.key,
  path: entry.path,
  place: entry.place,
  body: entry.body,
  feedback: feedbackOf(entry),
  deleting: entry.deleting,
  published: entry.published,
  local: isLocal(entry),
})

const isDraftNotFound = (cause: Cause.Cause<unknown>) =>
  Option.exists(Cause.findErrorOption(cause), Predicate.isTagged("DraftNotFound"))

export class DraftStore {
  readonly #runtime: BackendRuntime
  readonly #record: (activity: Activity) => void
  readonly #entriesAtom = Atom.make<ReadonlyMap<string, Entry>>(new Map())
  readonly #calls = new Set<Promise<void>>()
  readonly #holdsAtom = Atom.make(0)
  readonly viewAtom = Atom.family((key: string) =>
    Atom.map(
      Atom.make((get) => get(this.#entriesAtom).get(key)),
      (entry) => (entry === undefined ? undefined : toView(entry)),
    ),
  )
  readonly viewsAtom = Atom.make((get) =>
    [...get(this.#entriesAtom).keys()].flatMap((key) => {
      const view = get(this.viewAtom(key))

      return view === undefined || view.published ? [] : [view]
    }),
  )
  readonly linePlacesAtom = Atom.make((get) =>
    [...get(this.#entriesAtom).values()].flatMap(({ key, path, place }): Array<LineNotePlace> =>
      Predicate.isTagged(place, "LinePlace")
        ? [{ key, path, side: place.side, line: place.line }]
        : [],
    ),
  ).pipe(Atom.withEquality<ReadonlyArray<LineNotePlace>>(sameLineNotePlaces))
  readonly lockedAtom = Atom.make((get) => get(this.#holdsAtom) > 0)
  readonly summaryAtom = Atom.make("")
  readonly submissionAtom = Atom.make<Submission>(idle)
  readonly dispose: () => void
  #lastKey = 0
  #started: string | null = null

  constructor(
    readonly workspace: PullRequestWorkspace,
    readonly registry: AtomRegistry.AtomRegistry,
    record: (activity: Activity) => void,
    summary = "",
  ) {
    this.dispose = registry.mount(
      Atom.make((get) => {
        get(this.#entriesAtom)
        get(this.linePlacesAtom)
        get(this.lockedAtom)
        get(this.summaryAtom)
        get(this.submissionAtom)
      }),
    )
    this.#runtime = backendRuntimeOf(registry)
    this.#record = record
    this.registry.set(this.summaryAtom, summary)

    for (const { id, path, place, body } of workspace.drafts) {
      this.#add({ key: id, path, place, body, saved: { id, body } })
    }
  }

  readonly views = () => this.registry.get(this.viewsAtom)

  readonly linePlaces = () => this.registry.get(this.linePlacesAtom)

  readonly locked = () => this.registry.get(this.lockedAtom)

  readonly summary = () => this.registry.get(this.summaryAtom)

  readonly submission = () => this.registry.get(this.submissionAtom)

  setSummary(summary: string) {
    this.registry.set(this.summaryAtom, summary)
  }

  clearSubmitFailure() {
    const submission = this.submission()

    if (submission.type === "failed" && submission.problem.fixedByReload !== true) {
      this.#setSubmission(idle)
    }
  }

  view(key: string): DraftView | undefined {
    return this.registry.get(this.viewAtom(key))
  }

  start(path: string, side: DiffSide, line: number) {
    if (this.locked()) return

    for (const entry of this.registry.get(this.#entriesAtom).values()) {
      const { place } = entry

      if (
        entry.saved === null &&
        entry.body === "" &&
        entry.path === path &&
        Predicate.isTagged(place, "LinePlace") &&
        place.side === side &&
        place.line === line
      ) {
        this.#started = entry.key

        return
      }
    }

    const key = `new-${++this.#lastKey}`
    this.#started = key
    this.#add({ key, path, place: LinePlace.make({ side, line }), body: "", saved: null })
  }

  takeStarted(key: string) {
    if (this.#started !== key) return false

    this.#started = null

    return true
  }

  edit(key: string, body: string) {
    const entry = this.registry.get(this.#entriesAtom).get(key)

    if (entry === undefined || entry.deleting || entry.published || this.locked()) return

    this.#put({ ...entry, body, failure: null })
  }

  remove(key: string) {
    const entry = this.registry.get(this.#entriesAtom).get(key)

    if (entry === undefined || entry.published || this.locked()) return

    this.#save({ ...entry, deleting: true })
  }

  /** Drops a Draft GitHub has never seen, handing back its line and text. */
  takeLocal(key: string) {
    const entry = this.registry.get(this.#entriesAtom).get(key)

    if (entry === undefined || !isLocal(entry) || this.locked()) return undefined

    const { path, place, body } = entry

    if (!Predicate.isTagged(place, "LinePlace")) return undefined

    this.#save({ ...entry, deleting: true })

    return { place: { path, side: place.side, line: place.line }, body }
  }

  save(key: string) {
    const entry = this.registry.get(this.#entriesAtom).get(key)

    if (entry !== undefined && !this.locked() && mayNeedCall(entry)) {
      this.#request(entry)
    }
  }

  async lockAndSave() {
    this.registry.update(this.#holdsAtom, (holds) => holds + 1)

    for (const entry of this.registry.get(this.#entriesAtom).values()) {
      if (entry.failure === null && mayNeedCall(entry)) this.#request(entry)
    }

    while (this.#calls.size > 0) await Promise.all(this.#calls)
  }

  unlock() {
    this.registry.update(this.#holdsAtom, (holds) => holds - 1)
  }

  async submit(decision: ReviewDecision, summary: string): Promise<SubmitOutcome> {
    const submission = this.submission()

    if (submission.type === "failed" && submission.problem.fixedByReload === true) {
      return submission
    }

    this.#setSubmission({ type: "sending" })
    await this.lockAndSave()

    if (this.hasUnsaved()) {
      this.#setSubmission({ type: "failed", problem: unsavedProblem })
      this.unlock()

      return { type: "failed", problem: unsavedProblem }
    }

    const { pullRequest, revision } = this.workspace

    const call = this.#runtime.runPromiseExit(
      Backend.use((backend) =>
        backend.SubmitReview({ pullRequestId: pullRequest.id, revision, decision, summary }),
      ),
    )

    const done = call.then(() => {
      this.#calls.delete(done)
    })

    this.#calls.add(done)
    const exit = await call

    let outcome: SubmitOutcome

    if (Exit.isSuccess(exit)) {
      const drafts = [...this.registry.get(this.#entriesAtom).values()].flatMap(
        ({ path, place, saved, published }) =>
          saved === null || published
            ? []
            : [new Draft({ id: saved.id, path, place, body: saved.body })],
      )

      this.#record(
        ReviewSubmitted.make({
          pullRequest: activityPullRequest(this.workspace),
          decision,
          summary,
          drafts,
        }),
      )

      this.registry.update(
        this.#entriesAtom,
        (entries) =>
          new Map(
            [...entries].flatMap(([key, entry]) =>
              entry.saved === null ? [] : [[key, { ...entry, published: true }]],
            ),
          ),
      )
      outcome = { type: "submitted", published: drafts.length }
    } else {
      outcome = { type: "failed", problem: submitProblem(exit.cause) }
    }

    this.#setSubmission(outcome.type === "failed" ? outcome : idle)
    this.unlock()

    return outcome
  }

  discardUnsaved() {
    this.registry.update(this.#entriesAtom, (entries) => {
      const saved = new Map<string, Entry>()

      for (const [key, entry] of entries) {
        if (entry.saved !== null) {
          saved.set(key, { ...entry, body: entry.saved.body, deleting: false, failure: null })
        }
      }

      return saved
    })

    this.#started = null
    this.registry.set(this.summaryAtom, "")
    this.registry.set(this.submissionAtom, idle)
  }

  hasUnsaved() {
    for (const entry of this.registry.get(this.#entriesAtom).values()) {
      if (pendingAction(entry) !== null) return true
    }

    return false
  }

  #add(fields: Pick<Entry, "key" | "path" | "place" | "body" | "saved">) {
    const entry = {
      ...fields,
      sending: null,
      requested: false,
      deleting: false,
      failure: null,
      published: false,
    }

    this.#put(entry)
  }

  #nextCall(entry: Entry): Call | null {
    const { saved, body, place } = entry
    const action = pendingAction(entry)

    if (action === null) return null

    if (action === "delete" && saved !== null) {
      const run = Backend.use((backend) => backend.DeleteDraft({ id: saved.id }))

      return { action, run: Effect.as(run, null) }
    }

    if (saved !== null) {
      const run = Backend.use((backend) => backend.UpdateDraft({ id: saved.id, body }))

      return { action, run: Effect.as(run, { id: saved.id, body }) }
    }

    if (!Predicate.isTagged(place, "LinePlace")) return null

    const { pullRequest, revision } = this.workspace

    const run = Backend.use((backend) =>
      backend.CreateDraft({
        pullRequestId: pullRequest.id,
        revision,
        path: entry.path,
        side: place.side,
        line: place.line,
        body,
      }),
    )

    return { action: "save", run: Effect.map(run, ({ id }) => ({ id, body })) }
  }

  #request(entry: Entry) {
    this.#save({ ...entry, requested: true })
  }

  #save(entry: Entry) {
    if (entry.sending !== null) return this.#put(entry)

    if (entry.deleting && entry.saved === null) {
      this.registry.update(this.#entriesAtom, (entries) => {
        const next = new Map(entries)
        next.delete(entry.key)

        return next
      })

      return
    }

    const ready = { ...entry, requested: false }
    const call = this.#nextCall(ready)

    if (call === null) return this.#put(ready)

    this.#send(ready, call)
  }

  #send(entry: Entry, { action, run }: Call) {
    this.#put({ ...entry, sending: action, failure: null })

    const done = this.#runtime.runPromiseExit(run).then((exit) => {
      this.#calls.delete(done)
      const current = this.registry.get(this.#entriesAtom).get(entry.key)

      if (current === undefined) return

      let settled: Entry = { ...current, sending: null }

      if (Exit.isSuccess(exit)) {
        settled = { ...settled, saved: exit.value }
      } else if (isDraftNotFound(exit.cause)) {
        settled = { ...settled, saved: null, requested: true }
      } else if (!(current.deleting && action === "save")) {
        settled = { ...settled, failure: { action, problem: problemOf(exit.cause) } }
      }

      if ((settled.requested || settled.deleting) && settled.failure === null) this.#save(settled)
      else this.#put(settled)
    })

    this.#calls.add(done)
  }

  #put(entry: Entry) {
    this.registry.update(this.#entriesAtom, (entries) => new Map(entries).set(entry.key, entry))
  }

  #setSubmission(submission: Submission) {
    this.registry.set(this.submissionAtom, submission)
  }
}

export const useDraftViews = (store: DraftStore) => useAtomValue(store.viewsAtom)

export const useDraftCount = (store: DraftStore) =>
  useAtomValue(store.viewsAtom, (views) => views.length)

export const useLineDraftPlaces = (store: DraftStore) => useAtomValue(store.linePlacesAtom)

export const useDraftsLocked = (store: DraftStore) => useAtomValue(store.lockedAtom)

export const useReviewSummary = (store: DraftStore) => useAtomValue(store.summaryAtom)

export const useSubmission = (store: DraftStore) => useAtomValue(store.submissionAtom)

export const useDraft = (store: DraftStore, key: string) => useAtomValue(store.viewAtom(key))
