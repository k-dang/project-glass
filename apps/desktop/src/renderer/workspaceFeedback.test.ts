import {
  type ConnectionError,
  Discussions,
  Draft,
  GitHubUnavailable,
  LinePlace,
  OutdatedDiscussion,
  PullRequestWorkspace,
  PublishedComment,
} from "@glass/contracts"
import { DateTime, Effect, Exit } from "effect"
import { AtomRegistry } from "effect/reactivity"
import { expect, it, vi } from "vite-plus/test"
import { eventually } from "../../test/eventually"
import { type Held, hold, next, testRegistry } from "../../test/testBackend"
import { workspace } from "../../test/workspace"
import { backendRuntime } from "./backend"
import { WorkspaceFeedback, type ReloadFeedback } from "./workspaceFeedback"

const savedDraft = new Draft({
  id: "D1",
  path: "greet.ts",
  place: LinePlace.make({ side: "new", line: 2 }),
  body: "Saved",
})

const withDiscussion = () => {
  const original = workspace([savedDraft])

  return new PullRequestWorkspace({
    viewer: original.viewer,
    pullRequest: original.pullRequest,
    revision: original.revision,
    updatedAt: original.updatedAt,
    files: original.files,
    viewedPaths: original.viewedPaths,
    drafts: original.drafts,
    discussions: new Discussions({
      onLines: [],
      outdated: [
        new OutdatedDiscussion({
          id: "T1",
          path: "greet.ts",
          originalLine: 2,
          diffHunk: "",
          resolved: false,
          comments: [
            new PublishedComment({
              id: "C1",
              author: "hubot",
              avatarUrl: null,
              bodyHtml: "Why?",
              createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
            }),
          ],
        }),
      ],
      timeline: [],
    }),
  })
}

it("drains pending and newer Draft saves and other writes before replacing, carrying current unsent feedback", async () => {
  const updates: Array<Held<{ id: string; body: string }, void, ConnectionError>> = []
  const viewed: Array<Held<void, void, never>> = []
  const resolves: Array<Held<void, boolean, never>> = []
  const replacements: Array<Held<ReloadFeedback, void, never>> = []

  const confirm = vi.fn<(lost: ReadonlyArray<string>) => Effect.Effect<boolean>>(() =>
    Effect.succeed(true),
  )

  const registry = testRegistry({
    UpdateDraft: hold(updates),
    SetFileViewed: () => hold(viewed)(undefined),
    SetDiscussionResolved: () => hold(resolves)(undefined),
  })

  try {
    const feedback = new WorkspaceFeedback(withDiscussion(), registry, () => {})

    feedback.drafts.edit("D1", "First save")
    feedback.drafts.save("D1")
    const first = await next(updates)

    feedback.drafts.edit("D1", "Latest text")
    feedback.drafts.setSummary("Looks")
    feedback.replies.edit("T1", "Keep this Reply")
    feedback.replies.edit("gone", "Discussion removed by GitHub")
    feedback.viewedFiles.set("greet.ts", true)
    feedback.resolutions.set("T1", true)
    const viewing = await next(viewed)
    const resolving = await next(resolves)
    const reloading = Effect.runPromise(feedback.prepareReload(confirm, hold(replacements)))

    first.answer(Effect.void)
    const latest = await next(updates)

    expect(latest.payload.body).toBe("Latest text")
    latest.answer(Effect.void)
    viewing.answer(Effect.void)
    await eventually(() => expect(feedback.viewedFiles.snapshot().saving.size).toBe(0))
    expect(replacements).toHaveLength(0)
    expect(confirm).not.toHaveBeenCalled()

    resolving.answer(Effect.succeed(true))
    const replacement = await next(replacements)

    feedback.drafts.setSummary("Looks close")

    const nextFeedback = new WorkspaceFeedback(
      withDiscussion(),
      registry,
      () => {},
      replacement.payload,
    )

    expect(nextFeedback.drafts.summary()).toBe("Looks close")
    expect(nextFeedback.replies.view("T1").body).toBe("Keep this Reply")
    expect(nextFeedback.replies.view("gone").body).toBe("")
    expect(confirm).toHaveBeenCalledExactlyOnceWith([])
    feedback.dispose()
    replacement.answer(Effect.void)
    await reloading
    nextFeedback.dispose()
  } finally {
    registry.dispose()
  }
})

it.each(["reload", "leave"])(
  "preserves editable text when a save fails and the user refuses to discard during %s",
  async (operation) => {
    const updates: Array<Held<{ id: string; body: string }, void, ConnectionError>> = []
    const choices: Array<Held<ReadonlyArray<string>, boolean, never>> = []
    const registry = testRegistry({ UpdateDraft: hold(updates) })

    try {
      const feedback = new WorkspaceFeedback(withDiscussion(), registry, () => {})

      feedback.drafts.edit("D1", "Unsent Draft")
      feedback.drafts.setSummary("Unsent summary")
      feedback.replies.edit("T1", "Unsent Reply")

      const preparing = Effect.runPromise(
        operation === "reload"
          ? feedback.prepareReload(hold(choices), () => Effect.die("Discard was refused"))
          : feedback.prepareLeave(hold(choices)).pipe(Effect.asVoid),
      )

      ;(await next(updates)).answer(Effect.fail(new GitHubUnavailable({ message: "Offline" })))
      const choice = await next(choices)

      expect(choice.payload).toEqual(
        operation === "reload"
          ? ["Drafts that couldn't save to GitHub"]
          : [
              "Drafts that couldn't save to GitHub",
              "Replies you haven't published",
              "your Review summary",
            ],
      )
      choice.answer(Effect.succeed(false))
      await preparing

      expect(feedback.drafts.view("D1")?.body).toBe("Unsent Draft")
      expect(feedback.drafts.summary()).toBe("Unsent summary")
      expect(feedback.replies.view("T1").body).toBe("Unsent Reply")
      feedback.drafts.edit("D1", "Editable Draft")
      feedback.replies.edit("T1", "Editable Reply")
      expect(feedback.drafts.view("D1")?.body).toBe("Editable Draft")
      expect(feedback.replies.view("T1").body).toBe("Editable Reply")
      feedback.dispose()
    } finally {
      registry.dispose()
    }
  },
)

it("releases a cancelled Reload without releasing the overlapping leave hold", async () => {
  const viewed: Array<Held<void, void, never>> = []
  const choices: Array<Held<ReadonlyArray<string>, boolean, never>> = []
  const replace = vi.fn<() => Effect.Effect<void>>(() => Effect.void)
  const cancellation = new AbortController()
  const registry = testRegistry({ SetFileViewed: () => hold(viewed)(undefined) })

  try {
    const feedback = new WorkspaceFeedback(withDiscussion(), registry, () => {})

    feedback.replies.edit("T1", "Unsent")
    feedback.viewedFiles.set("greet.ts", true)
    const viewing = await next(viewed)

    const reloading = Effect.runPromiseExit(
      feedback.prepareReload(() => Effect.succeed(true), replace),
      { signal: cancellation.signal },
    )

    const leaving = Effect.runPromise(feedback.prepareLeave(hold(choices)))
    const choice = await next(choices)

    cancellation.abort()
    expect(Exit.isFailure(await reloading)).toBe(true)
    feedback.drafts.edit("D1", "Ignored")
    feedback.replies.edit("T1", "Ignored")
    expect(feedback.drafts.view("D1")?.body).toBe("Saved")
    expect(feedback.replies.view("T1").body).toBe("Unsent")
    expect(feedback.viewedFiles.snapshot().locked).toBe(false)
    expect(registry.get(feedback.resolutions.lockedAtom)).toBe(false)

    choice.answer(Effect.succeed(false))
    expect(await leaving).toBe(false)
    feedback.drafts.edit("D1", "Editable")
    feedback.replies.edit("T1", "Editable")
    expect(feedback.drafts.view("D1")?.body).toBe("Editable")
    expect(feedback.replies.view("T1").body).toBe("Editable")
    viewing.answer(Effect.void)
    await eventually(() => expect(feedback.viewedFiles.snapshot().saving.size).toBe(0))
    expect(replace).not.toHaveBeenCalled()
    feedback.dispose()
  } finally {
    registry.dispose()
  }
})

it("releases holds when confirmation defects or is interrupted", async () => {
  const registry = testRegistry({})

  try {
    const feedback = new WorkspaceFeedback(withDiscussion(), registry, () => {})

    const failure = await Effect.runPromiseExit(
      feedback.prepareLeave(() => Effect.die("Prompt failed")),
    )

    expect(Exit.isFailure(failure)).toBe(true)
    const choices: Array<Held<ReadonlyArray<string>, boolean, never>> = []
    const cancellation = new AbortController()

    const leaving = Effect.runPromiseExit(feedback.prepareLeave(hold(choices)), {
      signal: cancellation.signal,
    })

    await next(choices)
    cancellation.abort()
    expect(Exit.isFailure(await leaving)).toBe(true)
    feedback.drafts.edit("D1", "Editable")
    feedback.replies.edit("T1", "Editable")
    expect(feedback.drafts.view("D1")?.body).toBe("Editable")
    expect(feedback.replies.view("T1").body).toBe("Editable")
    feedback.dispose()
  } finally {
    registry.dispose()
  }
})

it("disposes its stores, cancelling an Ask and releasing workspace atoms", async () => {
  const interrupted = vi.fn<() => void>()
  const asking = Promise.withResolvers<void>()

  const registry = testRegistry({
    Ask: () =>
      Effect.sync(() => asking.resolve()).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(interrupted)),
      ),
  })

  try {
    await Effect.runPromise(AtomRegistry.getResult(registry, backendRuntime))
    const baseline = registry.getNodes().size
    const askAnswersKeptPerRevision = 1
    const feedback = new WorkspaceFeedback(withDiscussion(), registry, () => {})

    feedback.asks.ask({ path: "greet.ts", side: "new", line: 2 }, "Why?")
    await asking.promise
    feedback.dispose()
    await eventually(() => expect(interrupted).toHaveBeenCalledOnce())
    await eventually(() =>
      expect(registry.getNodes().size).toBe(baseline + askAnswersKeptPerRevision),
    )
  } finally {
    registry.dispose()
  }
})
