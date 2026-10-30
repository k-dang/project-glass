import {
  type Activity,
  type ConnectionError,
  type CreateDraftError,
  Draft,
  DraftNotFound,
  FlaggedPlace,
  GitHubUnavailable,
  LinePlace,
  type NewDraft,
  type Revision,
  type ReviewDecision,
  ReviewRejected,
  ReviewSubmitted,
  StaleRevision,
  type SubmitReviewError,
  type UpdateDraftError,
} from "@glass/contracts"
import { Effect } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { eventually } from "../../test/eventually"
import { DraftStore } from "./useDrafts"
import { type Held, hold, next, testRegistry } from "../../test/testBackend"
import { recordedPullRequest, revision, workspace } from "../../test/workspace"

const draftStore = (drafts: ReadonlyArray<Draft> = []) => {
  const creates: Array<Held<NewDraft, Draft, typeof CreateDraftError.Type>> = []
  const updates: Array<Held<{ id: string; body: string }, void, typeof UpdateDraftError.Type>> = []
  const deletes: Array<Held<{ id: string }, void, typeof ConnectionError.Type>> = []

  const submits: Array<
    Held<
      { pullRequestId: string; revision: Revision; decision: ReviewDecision; summary: string },
      void,
      typeof SubmitReviewError.Type
    >
  > = []

  const recorded: Array<Activity> = []

  const registry = testRegistry({
    CreateDraft: hold(creates),
    UpdateDraft: hold(updates),
    DeleteDraft: hold(deletes),
    SubmitReview: hold(submits),
  })

  const store = new DraftStore(workspace(drafts), registry, (activity) => {
    recorded.push(activity)
  })

  return {
    store,
    creates,
    updates,
    deletes,
    submits,
    recorded,
    made: () => creates.length + updates.length + deletes.length,
  }
}

const onGitHub = (body: string) =>
  new Draft({ id: "D1", path: "greet.ts", place: LinePlace.make({ side: "new", line: 2 }), body })

const loaded = onGitHub("Hi")

const flagged = new Draft({
  id: "D2",
  path: "greet.ts",
  place: FlaggedPlace.make({ originalLine: 1, diffHunk: "@@ -1 +1 @@\n-hi\n+hello" }),
  body: "Was this hi?",
})

const save = (store: DraftStore, key: string, body: string) => {
  store.edit(key, body)
  store.save(key)
}

const start = (store: DraftStore) => {
  store.start("greet.ts", "new", 2)

  return store.views()[0]!.key
}

describe("DraftStore", () => {
  it("keeps other Draft cards and line markers stable while editing and saving", async () => {
    const { store, updates } = draftStore([loaded, flagged])
    const unmount = store.registry.mount(store.viewsAtom)
    const other = store.view("D2")
    const places = store.linePlaces()

    save(store, "D1", "Hi!")
    expect(store.view("D2")).toBe(other)
    expect(store.linePlaces()).toBe(places)

    ;(await next(updates)).answer(Effect.void)
    await eventually(() => expect(store.view("D1")?.feedback).toEqual({ type: "draft" }))

    expect(store.view("D2")).toBe(other)
    expect(store.linePlaces()).toBe(places)
    unmount()
  })

  it("saves only when asked, sending a save asked for mid-call once that call lands", async () => {
    const { store, creates, updates, made } = draftStore()
    const key = start(store)

    store.edit(key, "Why")
    expect(store.view(key)?.feedback).toEqual({ type: "unsaved" })
    expect(made()).toBe(0)

    store.save(key)
    const create = await next(creates)
    store.edit(key, "Why?")

    expect(create.payload).toMatchObject({ path: "greet.ts", side: "new", line: 2, body: "Why" })

    create.answer(Effect.succeed(onGitHub("Why")))
    await eventually(() => expect(store.view(key)?.feedback).toEqual({ type: "unsaved" }))
    expect(made()).toBe(0)

    save(store, key, "Why??")
    const update = await next(updates)
    save(store, key, "Why???")
    update.answer(Effect.void)

    expect((await next(updates)).payload).toEqual({ id: "D1", body: "Why???" })
  })

  it("saves text restored to its last saved version while a save of other text is out", async () => {
    const { store, updates } = draftStore([loaded])

    save(store, "D1", "Hi!")
    const update = await next(updates)
    save(store, "D1", "Hi")
    update.answer(Effect.void)

    expect((await next(updates)).payload).toEqual({ id: "D1", body: "Hi" })
  })

  it("deletes a Draft from GitHub when its text is cleared, keeping its card", async () => {
    const { store, deletes } = draftStore([loaded])

    save(store, "D1", "  ")
    const deletion = await next(deletes)
    deletion.answer(Effect.void)

    expect(deletion.payload).toEqual({ id: "D1" })
    await eventually(() => expect(store.view("D1")?.feedback).toBeNull())
    expect(store.hasUnsaved()).toBe(false)
  })

  it("creates a new Draft from text whose Draft is gone from GitHub", async () => {
    const { store, creates, updates } = draftStore([loaded])

    save(store, "D1", "Hi!")
    ;(await next(updates)).answer(Effect.fail(new DraftNotFound({ id: "D1" })))

    expect((await next(creates)).payload).toMatchObject({
      path: "greet.ts",
      side: "new",
      line: 2,
      body: "Hi!",
    })
  })

  it("hands off only a Draft GitHub has never seen, dropping it without a call", async () => {
    const { store, creates, made } = draftStore()
    const key = start(store)

    store.edit(key, "Who calls this?")
    expect(store.takeLocal(key)).toEqual({
      place: { path: "greet.ts", side: "new", line: 2 },
      body: "Who calls this?",
    })
    expect(store.views()).toEqual([])

    const sending = start(store)
    save(store, sending, "Why")
    const create = await next(creates)
    expect(store.takeLocal(sending)).toBeUndefined()

    create.answer(Effect.succeed(onGitHub("Why")))
    await eventually(() => expect(store.views()[0]!.local).toBe(false))
    expect(store.takeLocal(sending)).toBeUndefined()
    expect(made()).toBe(0)
  })

  it("deletes a Draft removed while it is being created, once GitHub gives it an ID", async () => {
    const { store, creates, deletes, made } = draftStore()
    const key = start(store)

    save(store, key, "Why")
    const create = await next(creates)
    store.remove(key)

    expect(made()).toBe(0)

    create.answer(Effect.succeed(onGitHub("Why")))
    const deletion = await next(deletes)
    deletion.answer(Effect.void)

    expect(deletion.payload).toEqual({ id: "D1" })
    await eventually(() => expect(store.views()).toHaveLength(0))
  })

  it("keeps text whose save failed until a retry saves it", async () => {
    const { store, updates } = draftStore([loaded])

    save(store, "D1", "Hi!")
    ;(await next(updates)).answer(Effect.fail(new GitHubUnavailable({ message: "Down" })))

    await eventually(() =>
      expect(store.view("D1")?.feedback).toMatchObject({ type: "failed", action: "save" }),
    )
    expect(store.view("D1")?.body).toBe("Hi!")
    expect(store.hasUnsaved()).toBe(true)

    store.save("D1")
    const retry = await next(updates)

    expect(retry.payload).toEqual({ id: "D1", body: "Hi!" })

    retry.answer(Effect.void)

    await eventually(() => expect(store.view("D1")?.feedback).toEqual({ type: "draft" }))
    expect(store.view("D1")?.body).toBe("Hi!")
    expect(store.hasUnsaved()).toBe(false)
  })

  it("locks by saving unsaved text, then ignores changes until unlocked", async () => {
    const { store, updates, made } = draftStore([loaded])

    store.edit("D1", "Hi!")

    const locked = store.lockAndSave()

    const update = await next(updates)

    expect(update.payload).toEqual({ id: "D1", body: "Hi!" })

    update.answer(Effect.void)
    await locked

    expect(store.hasUnsaved()).toBe(false)

    save(store, "D1", "Hi?")
    store.remove("D1")

    expect(store.view("D1")).toMatchObject({ body: "Hi!", deleting: false })
    expect(made()).toBe(0)

    store.unlock()
    save(store, "D1", "Hi?")

    expect((await next(updates)).payload).toEqual({ id: "D1", body: "Hi?" })
  })

  it("locks by also saving text edited while an earlier save was out", async () => {
    const { store, updates } = draftStore([loaded])

    save(store, "D1", "Hi!")
    const first = await next(updates)
    store.edit("D1", "Hi?")
    const locked = store.lockAndSave()
    first.answer(Effect.void)

    const second = await next(updates)
    expect(second.payload).toEqual({ id: "D1", body: "Hi?" })
    second.answer(Effect.void)
    await locked

    expect(store.hasUnsaved()).toBe(false)
  })

  it("saves unsaved text before submitting the Review, then holds no Drafts", async () => {
    const { store, updates, submits } = draftStore([loaded])

    store.edit("D1", "Hi!")

    const submitting = store.submit("approve", "LGTM")

    const update = await next(updates)

    expect(update.payload).toEqual({ id: "D1", body: "Hi!" })
    expect(submits).toHaveLength(0)

    update.answer(Effect.void)
    const submit = await next(submits)

    expect(submit.payload).toEqual({
      pullRequestId: "PR_1",
      revision,
      decision: "approve",
      summary: "LGTM",
    })

    submit.answer(Effect.void)

    expect(await submitting).toEqual({ type: "submitted", published: 1 })
    expect(store.views()).toEqual([])
  })

  it("keeps a published Draft on its line, read-only, until Reload replaces the store", async () => {
    const { store, submits, made } = draftStore([loaded])
    store.start("greet.ts", "new", 3)
    const blank = store.views()[1]!.key

    const submitting = store.submit("comment", "")

    ;(await next(submits)).answer(Effect.void)
    await submitting

    expect(store.view("D1")).toMatchObject({ body: "Hi", published: true })
    expect(store.view(blank)).toBeUndefined()
    expect(store.linePlaces().map((place) => place.key)).toEqual(["D1"])

    save(store, "D1", "Hi again")
    store.remove("D1")

    expect(store.view("D1")?.body).toBe("Hi")
    expect(made()).toBe(0)
  })

  it("records the Review with every Draft it published, Flagged drafts included, once GitHub takes it", async () => {
    const { store, updates, submits, recorded } = draftStore([loaded, flagged])

    store.edit("D1", "Hi!")

    const submitting = store.submit("request-changes", "Say hello first.")

    ;(await next(updates)).answer(Effect.void)
    ;(await next(submits)).answer(Effect.void)
    await submitting

    expect(recorded).toEqual([
      ReviewSubmitted.make({
        pullRequest: recordedPullRequest,
        decision: "request-changes",
        summary: "Say hello first.",
        drafts: [onGitHub("Hi!"), flagged],
      }),
    ])
  })

  it("records only the Review GitHub takes, not one that failed before it", async () => {
    const { store, submits, recorded } = draftStore([loaded])

    const failing = store.submit("approve", "")

    ;(await next(submits)).answer(Effect.fail(new ReviewRejected({ message: "No" })))
    await failing

    const submitting = store.submit("comment", "Second try")

    ;(await next(submits)).answer(Effect.void)
    await submitting

    expect(recorded).toEqual([
      ReviewSubmitted.make({
        pullRequest: recordedPullRequest,
        decision: "comment",
        summary: "Second try",
        drafts: [loaded],
      }),
    ])
  })

  it("keeps every Draft when the Review fails", async () => {
    const { store, submits } = draftStore([loaded])

    const submitting = store.submit("comment", "")

    ;(await next(submits)).answer(Effect.fail(new StaleRevision()))

    expect(await submitting).toMatchObject({ type: "failed", problem: { fixedByReload: true } })
    expect(store.views().map((view) => view.body)).toEqual(["Hi"])
    expect(store.locked()).toBe(false)
  })

  it("asks for a Reload, not a retry, when GitHub may have taken the Review", async () => {
    const { store, submits } = draftStore([loaded])

    const submitting = store.submit("approve", "")

    ;(await next(submits)).answer(Effect.fail(new GitHubUnavailable({ message: "Timed out" })))

    expect(await submitting).toMatchObject({ type: "failed", problem: { fixedByReload: true } })
    expect(await store.submit("approve", "")).toMatchObject({ problem: { fixedByReload: true } })
    expect(submits).toHaveLength(0)
  })

  it("holds the submission state, keeping a may-have-submitted failure until the store is replaced", async () => {
    const { store, submits } = draftStore([loaded])

    const submitting = store.submit("approve", "")
    expect(store.submission()).toEqual({ type: "sending" })

    ;(await next(submits)).answer(Effect.fail(new GitHubUnavailable({ message: "Timed out" })))
    await submitting
    store.clearSubmitFailure()

    expect(store.submission()).toMatchObject({ type: "failed", problem: { fixedByReload: true } })
  })

  it("clears a retryable submission failure when asked", async () => {
    const { store, updates } = draftStore([loaded])

    save(store, "D1", "Hi!")
    ;(await next(updates)).answer(Effect.fail(new GitHubUnavailable({ message: "Down" })))
    await eventually(() => expect(store.view("D1")?.feedback?.type).toBe("failed"))
    await store.submit("approve", "")
    expect(store.submission().type).toBe("failed")

    store.clearSubmitFailure()

    expect(store.submission()).toEqual({ type: "idle" })
  })

  it("submits no Review while a Draft hasn't saved to GitHub", async () => {
    const { store, updates, submits } = draftStore([loaded])

    save(store, "D1", "Hi!")
    ;(await next(updates)).answer(Effect.fail(new GitHubUnavailable({ message: "Down" })))
    await eventually(() => expect(store.view("D1")?.feedback?.type).toBe("failed"))

    expect(await store.submit("approve", "")).toMatchObject({ type: "failed" })
    expect(submits).toHaveLength(0)
    expect(store.locked()).toBe(false)
  })
})
