import { useAtomValue } from "@effect/atom-react"
import {
  type Activity,
  type DiffSide,
  Draft,
  LinePlace,
  type PullRequestWorkspace,
  type ReviewDecision,
  ReviewSubmitted,
} from "@glass/contracts"
import { Cause, Effect, Exit, Match, Option, Predicate } from "effect"
import { Atom, type AtomRegistry } from "effect/reactivity"
import { activityPullRequest } from "./activity"
import { Backend, backendRuntimeOf, type BackendError, type BackendRuntime } from "./backend"
import { type LineNotePlace, sameLineNotePlaces } from "./changesView"
import {
  type DraftEntry,
  type DraftEvent,
  type DraftView,
  type DraftWrite,
  draftView,
  isLocalDraft,
  pendingDraftWrite,
  type SavedDraft,
  stepDraft,
} from "./draftSync"
import { type Problem, problemOf } from "./problems"

export type SubmitOutcome =
  | { readonly type: "submitted"; readonly published: number }
  | { readonly type: "failed"; readonly problem: Problem }

export type Submission =
  | { readonly type: "idle" | "sending" | "submitted" }
  | Extract<SubmitOutcome, { readonly type: "failed" }>

const idle: Submission = { type: "idle" }

export const isPublishing = ({ type }: Submission) => type === "sending" || type === "submitted"

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

const isDraftNotFound = (cause: Cause.Cause<unknown>) =>
  Option.exists(Cause.findErrorOption(cause), Predicate.isTagged("DraftNotFound"))

export class DraftStore {
  readonly #runtime: BackendRuntime
  readonly #record: (activity: Activity) => void
  readonly #entriesAtom = Atom.make<ReadonlyMap<string, DraftEntry>>(new Map())
  readonly #calls = new Set<Promise<void>>()
  readonly #holdsAtom = Atom.make(0)
  readonly viewAtom = Atom.family((key: string) =>
    Atom.map(
      Atom.make((get) => get(this.#entriesAtom).get(key)),
      (entry) => (entry === undefined ? undefined : draftView(entry)),
    ),
  )
  readonly viewsAtom = Atom.make((get) =>
    get(this.submissionAtom).type === "submitted"
      ? []
      : [...get(this.#entriesAtom).keys()].flatMap((key) => {
          const view = get(this.viewAtom(key))

          return view === undefined ? [] : [view]
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

  readonly #closed = () => this.locked() || this.submission().type === "submitted"

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
    if (this.#closed()) return

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

    this.#started = this.#addLine(path, side, line, "")
  }

  add(path: string, side: DiffSide, line: number, body: string) {
    if (this.#closed()) return

    this.save(this.#addLine(path, side, line, body))
  }

  takeStarted(key: string) {
    if (this.#started !== key) return false

    this.#started = null

    return true
  }

  edit(key: string, body: string) {
    if (this.#closed()) return

    this.#transition(key, { type: "edit", body })
  }

  remove(key: string) {
    if (this.#closed()) return

    this.#transition(key, { type: "remove" })
  }

  takeLocal(key: string) {
    const entry = this.registry.get(this.#entriesAtom).get(key)

    if (entry === undefined || !isLocalDraft(entry) || this.#closed()) return undefined

    const { path, place, body } = entry

    if (!Predicate.isTagged(place, "LinePlace")) return undefined

    this.#transition(key, { type: "remove" })

    return { place: { path, side: place.side, line: place.line }, body }
  }

  save(key: string) {
    if (this.#closed()) return

    this.#transition(key, { type: "save" })
  }

  async lockAndSave() {
    this.registry.update(this.#holdsAtom, (holds) => holds + 1)

    for (const entry of this.registry.get(this.#entriesAtom).values()) {
      if (entry.sync.type !== "failed") this.#transition(entry.key, { type: "save" })
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
        ({ path, place, saved }) =>
          saved === null ? [] : [new Draft({ id: saved.id, path, place, body: saved.body })],
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
        (entries) => new Map([...entries].filter(([, entry]) => entry.saved !== null)),
      )
      outcome = { type: "submitted", published: drafts.length }
    } else {
      outcome = { type: "failed", problem: submitProblem(exit.cause) }
    }

    this.#setSubmission(outcome.type === "failed" ? outcome : { type: "submitted" })
    this.unlock()

    return outcome
  }

  discardUnsaved() {
    this.registry.update(this.#entriesAtom, (entries) => {
      const saved = new Map<string, DraftEntry>()

      for (const [key, entry] of entries) {
        const restored = stepDraft(entry, { type: "discard" }).entry

        if (restored !== null) saved.set(key, restored)
      }

      return saved
    })

    this.#started = null
    this.registry.set(this.summaryAtom, "")
    this.registry.set(this.submissionAtom, idle)
  }

  hasUnsaved() {
    for (const entry of this.registry.get(this.#entriesAtom).values()) {
      if (pendingDraftWrite(entry) !== null) return true
    }

    return false
  }

  #addLine(path: string, side: DiffSide, line: number, body: string) {
    const key = `new-${++this.#lastKey}`
    this.#add({ key, path, place: LinePlace.make({ side, line }), body, saved: null })

    return key
  }

  #add(fields: Pick<DraftEntry, "key" | "path" | "place" | "body" | "saved">) {
    const entry: DraftEntry = {
      ...fields,
      intent: "edit",
      sync: { type: "idle" },
    }

    this.registry.update(this.#entriesAtom, (entries) => new Map(entries).set(entry.key, entry))
  }

  #run(write: DraftWrite): Effect.Effect<SavedDraft | null, BackendError, Backend> {
    const { pullRequest, revision } = this.workspace

    return Match.value(write).pipe(
      Match.discriminatorsExhaustive("type")({
        create: ({ path, side, line, body }) =>
          Backend.use((backend) =>
            backend.CreateDraft({
              pullRequestId: pullRequest.id,
              revision,
              path,
              side,
              line,
              body,
            }),
          ).pipe(Effect.map(({ id }) => ({ id, body }))),
        update: ({ id, body }) =>
          Backend.use((backend) => backend.UpdateDraft({ id, body })).pipe(Effect.as({ id, body })),
        delete: ({ id }) =>
          Backend.use((backend) => backend.DeleteDraft({ id })).pipe(Effect.as(null)),
      }),
    )
  }

  #transition(key: string, event: DraftEvent) {
    const current = this.registry.get(this.#entriesAtom).get(key)

    if (current === undefined) return

    const { entry, write } = stepDraft(current, event)

    if (entry === current && write === null) return

    this.registry.update(this.#entriesAtom, (entries) => {
      const next = new Map(entries)

      if (entry === null) next.delete(key)
      else next.set(key, entry)

      return next
    })

    if (write === null) return

    const done = this.#runtime.runPromiseExit(this.#run(write)).then((exit) => {
      this.#calls.delete(done)
      this.#transition(
        key,
        Exit.isSuccess(exit)
          ? { type: "saved", saved: exit.value }
          : isDraftNotFound(exit.cause)
            ? { type: "missing" }
            : { type: "failed", problem: problemOf(exit.cause) },
      )
    })

    this.#calls.add(done)
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
