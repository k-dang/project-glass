import { assert, it } from "@effect/vitest"
import {
  ThreadStarted,
  LineNote,
  PageNote,
  PageText,
  SandboxPlace,
  TextPatch,
  UnsentFeedback,
  localPlace,
  toDoMention,
} from "@glass/contracts"
import { Effect, Fiber, Option, Predicate, Stream } from "effect"
import { existsSync } from "node:fs"
import { mkdir, rename, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  threadsFixture,
  threadsFixtureWith,
  holding,
  repository,
  scriptedHost,
  settled,
} from "../test/threadsFixture"
import type { FakePullRequest } from "../test/fakePullRequest"
import { gitIn } from "../test/gitRepositories"
import { isolatedHome } from "../test/harness"

it.live("links a clone as the Local checkout of the GitHub repository it names, and keeps it", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    const elsewhere = yield* isolatedHome
    const unpublished = join(elsewhere, "unpublished")
    gitIn(elsewhere, "init", "--quiet", unpublished)

    for (const path of [elsewhere, unpublished]) {
      const refused = yield* f.client.LinkLocalCheckout({ path }).pipe(Effect.flip)
      assert.equal(refused._tag, "InvalidLocalCheckout")
    }

    yield* Effect.promise(() => mkdir(join(f.clone.checkout, "src")))

    const linked = yield* f.client.LinkLocalCheckout({ path: join(f.clone.checkout, "src") })

    assert.deepStrictEqual(linked.repository, repository)
    assert.equal(linked.path, resolve(gitIn(f.clone.checkout, "rev-parse", "--show-toplevel")))

    const restarted = yield* f.restart
    const [kept] = yield* restarted.ListLocalCheckouts()
    assert.deepStrictEqual(kept?.repository, repository)
    assert.equal(kept?.path, linked.path)

    const onThisDevice = { place: localPlace, repository }
    assert.equal(yield* restarted.GetNewThreadDefaultBranch(onThisDevice), "main")
    assert.sameMembers(
      [...(yield* restarted.ListNewThreadBranches(onThisDevice))],
      ["main", "develop"],
    )
  }),
)

it.live("lists a Followed repository's branches from GitHub, for a Sandbox", () =>
  Effect.gen(function* () {
    const { github, client } = yield* threadsFixture
    const inSandbox = { place: SandboxPlace.make({ providerId: "fake" }), repository }
    const nowhere = { ...inSandbox, repository: { owner: "glass-demo", repo: "nowhere" } }
    const features = Array.from({ length: 150 }, (_, index) => `feature/${index}`)
    github.seedBranches(repository, {
      defaultBranch: "develop",
      branches: ["main", "develop", ...features],
    })

    assert.equal(yield* client.GetNewThreadDefaultBranch(inSandbox), "develop")

    const branches = yield* client.ListNewThreadBranches(inSandbox)
    assert.sameMembers([...branches], ["main", "develop", ...features])

    const missing = yield* client.ListNewThreadBranches(nowhere).pipe(Effect.flip)

    assert.equal(missing._tag, "GitHubUnavailable")

    const missingDefault = yield* client.GetNewThreadDefaultBranch(nowhere).pipe(Effect.flip)

    assert.equal(missingDefault._tag, "GitHubUnavailable")
  }),
)

it.live("fails only the Turn sent while the agent host bundle is missing", () =>
  Effect.gen(function* () {
    const bundle = join(yield* isolatedHome, "agentHost.mjs")
    const f = yield* threadsFixtureWith({ agentHostBundle: bundle })
    const thread = yield* f.start()

    const [failed] = yield* f.transcript(thread.id, settled(1))
    assert.equal(failed?.ended?.ending._tag, "Failed")

    yield* Effect.promise(() => symlink(scriptedHost, bundle))
    yield* f.send(thread.id, "Say hello again")

    const turns = yield* f.transcript(thread.id, settled(2))
    assert.equal(turns.at(-1)?.ended?.ending._tag, "Done")
  }),
)

it.live("starts a Thread in a worktree, on a new branch it names from its base", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    const thread = yield* f.start()
    const other = yield* f.start()
    const worktree = f.worktree(thread.name)

    assert.match(thread.name, /^agent\//)
    assert.notEqual(other.name, thread.name)
    assert.equal(gitIn(worktree, "branch", "--show-current"), thread.name)
    assert.equal(gitIn(worktree, "rev-parse", "HEAD"), f.clone.main)

    const [listed] = yield* f.client
      .WatchThreads()
      .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

    assert.deepStrictEqual(
      { id: listed?.id, place: listed?.place, repository: listed?.repository },
      { id: thread.id, place: localPlace, repository },
    )

    const { activities } = yield* f.client.ListActivity({ limit: 10 })
    assert.deepInclude(
      activities.map(({ activity }) => activity),
      ThreadStarted.make({
        threadId: thread.id,
        name: thread.name,
        repository,
        machine: "local",
        harness: "pi",
        message: "Say hello",
      }),
    )
  }),
)

it.live(
  "removes a Thread's worktree and transcript, warning about changes and keeping its branch",
  () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const thread = yield* f.start("hold:never")
      const worktree = f.worktree(thread.name)
      yield* f.transcript(thread.id, holding)

      const clean = yield* f.client.GetRemovalWarnings({ threadId: thread.id })
      assert.equal(clean.uncommittedChanges, "none")

      yield* Effect.promise(() => writeFile(join(worktree, "notes.txt"), "work in progress"))
      const dirty = yield* f.client.GetRemovalWarnings({ threadId: thread.id })
      assert.equal(dirty.uncommittedChanges, "some")

      yield* f.client.RemoveThread({ threadId: thread.id })

      assert.isFalse(existsSync(worktree))
      assert.equal(
        gitIn(f.clone.checkout, "branch", "--list", thread.name).replace("*", "").trim(),
        thread.name,
      )
      assert.lengthOf(
        yield* f.client.WatchThreads().pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
        0,
      )

      const gone = yield* f.client
        .WatchTranscript({ threadId: thread.id })
        .pipe(Stream.runHead, Effect.flip)

      assert.equal(gone._tag, "ThreadNotFound")
    }),
)

it.live(
  "diffs a Thread's files against its base, uncommitted work included, leaving git alone",
  () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const thread = yield* f.start("Make changes")
      const worktree = f.worktree(thread.name)
      yield* f.transcript(thread.id, settled(1))

      yield* Effect.promise(async () => {
        await writeFile(join(worktree, "committed.txt"), "done\n")
        gitIn(worktree, "add", "committed.txt")
        gitIn(
          worktree,
          "-c",
          "user.name=Thread",
          "-c",
          "user.email=agent@glass.invalid",
          "commit",
          "--quiet",
          "--no-gpg-sign",
          "-m",
          "Commit",
        )
        await writeFile(join(worktree, "staged.txt"), "staged \n")
        gitIn(worktree, "add", "staged.txt")
        await mkdir(join(worktree, "docs dir"))
        await rename(join(worktree, "README.md"), join(worktree, "docs dir", "read é.md"))
        await writeFile(join(worktree, "notes.txt"), "hello\n")
        await writeFile(join(worktree, "logo.bin"), Buffer.from([0, 1]))
      })

      const git = () => ({
        head: gitIn(worktree, "rev-parse", "HEAD"),
        branch: gitIn(worktree, "branch", "--show-current"),
        status: gitIn(worktree, "status", "--porcelain", "-uall"),
      })

      const before = git()
      const { files } = yield* f.client.GetThreadChanges({ threadId: thread.id })
      assert.deepStrictEqual(git(), before)
      assert.equal(before.branch, thread.name)
      assert.notEqual(before.head, f.clone.main)

      assert.deepStrictEqual(
        files.map(
          (file) =>
            `${file.changeType} ${file.previousPath === null ? "" : `${file.previousPath} → `}${file.path} +${file.additions} -${file.deletions} ${file.patch._tag}`,
        ),
        [
          "added committed.txt +1 -0 TextPatch",
          "renamed README.md → docs dir/read é.md +0 -0 NoTextChanges",
          "added logo.bin +0 -0 BinaryFile",
          "added notes.txt +1 -0 TextPatch",
          "added staged.txt +1 -0 TextPatch",
        ],
      )

      assert.deepStrictEqual(
        files.find(({ path }) => path === "staged.txt")?.patch,
        TextPatch.make({ hunks: "@@ -0,0 +1 @@\n+staged " }),
      )
    }),
)

it.live(
  "keeps a Thread's Feedback notes with the code they were left on until the Thread is removed",
  () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const thread = yield* f.start("Make changes")
      const worktree = f.worktree(thread.name)
      yield* f.transcript(thread.id, settled(1))
      yield* Effect.promise(() => writeFile(join(worktree, "notes.txt"), "one\ntwo\n"))

      const read = yield* f.client.GetThreadChanges({ threadId: thread.id })
      assert.equal((yield* f.client.GetThreadChanges({ threadId: thread.id })).id, read.id)

      const fields = {
        id: "note-1",
        path: "notes.txt",
        side: "new",
        start: 1,
        end: 2,
        code: "one\ntwo",
        changesId: read.id,
        text: "Say three too",
      } as const

      const note = new LineNote(fields)

      const other = new LineNote({
        ...fields,
        id: "note-2",
        start: 2,
        code: "two",
        text: "Drop",
      })

      const edited = new LineNote({ ...fields, text: "Say three and four" })

      yield* f.client.SaveFeedbackNote({ threadId: thread.id, note })
      yield* f.client.SaveFeedbackNote({ threadId: thread.id, note: other })
      yield* f.client.SaveFeedbackNote({ threadId: thread.id, note: edited })
      yield* f.client.RemoveFeedbackNote({ threadId: thread.id, noteId: other.id })

      yield* Effect.promise(() => writeFile(join(worktree, "notes.txt"), "one\nthree\n"))
      assert.notEqual((yield* f.client.GetThreadChanges({ threadId: thread.id })).id, read.id)

      const restarted = yield* f.restart
      assert.deepStrictEqual((yield* restarted.ListFeedbackNotes({ threadId: thread.id })).notes, [
        edited,
      ])

      yield* restarted.RemoveThread({ threadId: thread.id })

      const gone = yield* restarted.ListFeedbackNotes({ threadId: thread.id }).pipe(Effect.flip)

      assert.equal(gone._tag, "ThreadNotFound")
    }),
)

it.live(
  "attaches a Feedback note on a page to the next message as soon as it's saved, beside unstaged notes on changes",
  () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const thread = yield* f.start("Write a plan")
      const threadId = thread.id
      yield* f.transcript(threadId, settled(1))

      const onChanges = new LineNote({
        id: "line-1",
        path: "src/retry.ts",
        side: "new",
        start: 2,
        end: 2,
        code: "attempts++",
        changesId: "changes-1",
        text: "Cap the attempts",
      })

      const onPage = new PageNote({
        id: "page-1",
        path: "docs/plan.html",
        part: PageText.make({
          selector: "#limits > p",
          heading: "Limits",
          excerpt: "five per minute",
        }),
        text: "Make this ten",
      })

      yield* f.client.SaveFeedbackNote({ threadId, note: onChanges })
      yield* f.client.SaveFeedbackNote({ threadId, note: onPage })

      assert.deepStrictEqual(
        yield* f.client.ListFeedbackNotes({ threadId }),
        new UnsentFeedback({ notes: [onChanges, onPage], staged: [onPage.id] }),
      )
    }),
)

it.live(
  "queues staged Feedback notes for the working Thread as one message, taking only those notes",
  () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const thread = yield* f.start("hold:first")
      const threadId = thread.id
      yield* f.transcript(threadId, holding)

      const fields = {
        path: "src/retry.ts",
        side: "new",
        start: 2,
        end: 3,
        code: "attempts++\nreturn send()",
        changesId: "changes-1",
      } as const

      const capAttempts = new LineNote({ ...fields, id: "note-1", text: "Cap the attempts" })
      const keepError = new LineNote({ ...fields, id: "note-2", text: "Keep the last error" })
      const later = new LineNote({ ...fields, id: "note-3", text: "Not staged yet" })

      for (const note of [capAttempts, keepError])
        yield* f.client.SaveFeedbackNote({ threadId, note })

      const staged = [capAttempts.id, keepError.id]
      assert.deepStrictEqual((yield* f.client.StageFeedbackNotes({ threadId })).staged, staged)
      yield* f.client.SaveFeedbackNote({ threadId, note: later })

      const unstaged = { threadId, message: "", images: [], feedback: [later.id] }
      assert.equal((yield* f.client.SendMessage(unstaged).pipe(Effect.flip))._tag, "ThreadError")

      const sent = { threadId, message: "", images: [], feedback: staged }
      yield* f.client.SendMessage(sent)

      const { queued } = yield* f.watch(threadId, (transcript) => transcript.queued.length === 1)

      assert.deepStrictEqual(queued[0]?.feedback, [capAttempts, keepError])
      assert.deepStrictEqual(
        yield* f.client.ListFeedbackNotes({ threadId }),
        new UnsentFeedback({ notes: [later], staged: [] }),
      )

      const again = yield* f.client.SendMessage(sent).pipe(Effect.flip)
      assert.equal(again._tag, "ThreadError")
      assert.lengthOf((yield* f.client.ListFeedbackNotes({ threadId })).notes, 1)

      yield* f.release("first")
      yield* f.transcript(threadId, settled(2))

      const restarted = yield* f.restart

      const { turns, queued: left } = yield* f.watch(
        threadId,
        (transcript) => settled(2)(transcript.turns),
        restarted,
      )

      assert.lengthOf(left, 0)
      assert.deepStrictEqual(turns[1]?.feedback, [capAttempts, keepError])

      const received = turns[1]?.parts.flatMap((part) =>
        Predicate.isTagged(part, "Text") && part.text.includes("<glass_feedback>")
          ? [part.text]
          : [],
      )

      assert.include(received?.[0], "Keep the last error")
      assert.include(received?.[0], "attempts++\nreturn send()")
    }),
)

const queuedFeedback = Effect.gen(function* () {
  const f = yield* threadsFixture
  const thread = yield* f.start("hold:first")
  const threadId = thread.id
  yield* f.transcript(threadId, holding)

  const fields = {
    path: "src/retry.ts",
    side: "old",
    start: 4,
    end: 5,
    code: "attempts++\nreturn send()",
    changesId: "changes-1",
  } as const

  const sent = [
    new LineNote({ ...fields, id: "note-1", text: "Cap the attempts" }),
    new LineNote({ ...fields, id: "note-2", changesId: "changes-0", text: "Keep the error" }),
  ]

  for (const note of sent) yield* f.client.SaveFeedbackNote({ threadId, note })
  yield* f.client.StageFeedbackNotes({ threadId })
  yield* f.client.SendMessage({
    threadId,
    message: "",
    images: [],
    feedback: ["note-1", "note-2"],
  })

  const { queued } = yield* f.watch(threadId, (transcript) => transcript.queued.length === 1)
  const queuedId = queued[0]!.id

  const newer = new LineNote({ ...fields, id: "note-3", text: "Newer" })
  yield* f.client.SaveFeedbackNote({ threadId, note: newer })
  yield* f.client.StageFeedbackNotes({ threadId })

  return { f, threadId, sent, newer, queuedId }
})

it.live(
  "returns a canceled Queued message's Feedback notes beside newer ones, once and durably",
  () =>
    Effect.gen(function* () {
      const { f, threadId, sent, newer, queuedId } = yield* queuedFeedback
      const cancel = { threadId, queuedMessageId: queuedId }
      const restored = new UnsentFeedback({ notes: [newer, ...sent], staged: [newer.id] })

      assert.deepStrictEqual(yield* f.client.CancelQueuedMessage(cancel), restored)
      yield* f.watch(threadId, (transcript) => transcript.queued.length === 0)
      assert.deepStrictEqual(yield* f.client.CancelQueuedMessage(cancel), restored)

      const restarted = yield* f.restart
      assert.deepStrictEqual(yield* restarted.ListFeedbackNotes({ threadId }), restored)
    }),
)

it.live("refuses to cancel a Queued message whose Turn started, leaving its feedback sent", () =>
  Effect.gen(function* () {
    const { f, threadId, sent, newer, queuedId } = yield* queuedFeedback

    yield* f.release("first")
    yield* f.transcript(threadId, settled(2))

    const late = yield* f.client
      .CancelQueuedMessage({ threadId, queuedMessageId: queuedId })
      .pipe(Effect.flip)

    assert.equal(late._tag, "QueuedMessageStarted")
    assert.deepStrictEqual(
      yield* f.client.ListFeedbackNotes({ threadId }),
      new UnsentFeedback({ notes: [newer], staged: [newer.id] }),
    )
    assert.deepStrictEqual((yield* f.transcript(threadId, settled(2)))[1]?.feedback, sent)
  }),
)

it.live("lists a Thread as working while its Turn runs, until the Turn ends", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture

    const working = (until: (ids: ReadonlyArray<string>) => boolean) =>
      f.client.WatchWorkingThreads().pipe(Stream.filter(until), Stream.runHead)

    const thread = yield* f.start("hold:first")
    yield* f.transcript(thread.id, holding)
    yield* working((ids) => ids.includes(thread.id))

    yield* f.release("first")
    yield* f.transcript(thread.id, settled(1))
    yield* working((ids) => !ids.includes(thread.id))
  }),
)

it.live("finds a Thread's PR from the branch its agent left checked out, not a fork's", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    yield* f.client.FollowRepository({ input: "glass-demo/greeter" })

    const fromBranch = {
      owner: "glass-demo",
      repo: "greeter",
      headBranch: "feature/greeting",
      base: { sha: "b0", files: {} },
      head: { sha: "h1", files: {} },
    }

    f.github.seedPullRequest({ ...fromBranch, number: 7, updatedAt: "2026-11-01T00:00:00Z" })
    f.github.seedPullRequest({
      ...fromBranch,
      number: 8,
      isCrossRepository: true,
      updatedAt: "2026-11-02T00:00:00Z",
    })

    const thread = yield* f.start("hold:first")
    yield* f.transcript(thread.id, holding)
    gitIn(f.worktree(thread.name), "switch", "--quiet", "-c", "feature/greeting")
    yield* f.release("first")

    const [found] = yield* f.client.WatchThreadPullRequests().pipe(
      Stream.map((listed) => listed.filter(({ threadId }) => threadId === thread.id)),
      Stream.filter((listed) => listed.length > 0),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    )

    assert.equal(found?.ref.number, 7)

    const [listed] = yield* f.client
      .WatchThreads()
      .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

    assert.equal(listed?.branch, "feature/greeting")
  }),
)

it.live("marks the To-dos a Thread started from done once its PR merges", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    yield* f.client.FollowRepository({ input: "glass-demo/greeter" })
    yield* f.client.AddToDo({ title: "Fix spacing", notes: "" })
    yield* f.client.AddToDo({ title: "Tidy later", notes: "" })

    const pr = f.github.seedPullRequest({
      owner: "glass-demo",
      repo: "greeter",
      number: 7,
      headBranch: "feature/spacing",
      base: { sha: "b0", files: {} },
      head: { sha: "h1", files: {} },
    })

    const thread = yield* f.start(`hold:first
${toDoMention({ id: 1, title: "Fix spacing" })}`)

    yield* f.transcript(thread.id, holding)
    gitIn(f.worktree(thread.name), "switch", "--quiet", "-c", "feature/spacing")
    yield* f.release("first")
    yield* f.transcript(thread.id, settled(1))
    yield* f.send(thread.id, toDoMention({ id: 2, title: "Tidy later" }))
    yield* f.transcript(thread.id, settled(2))

    const finished = yield* f.client.WatchToDos().pipe(
      Stream.filter((toDos) => toDos.some(({ done }) => done)),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.forkChild,
    )

    pr.edit({ state: "MERGED" })
    yield* f.client.ListPullRequests()

    const listed = yield* Fiber.join(finished)

    assert.deepStrictEqual(
      listed.map(({ title, done }) => ({ title, done })),
      [
        { title: "Tidy later", done: false },
        { title: "Fix spacing", done: true },
      ],
    )
  }),
)

it.live(
  "settles a Thread once its PR merges, until the user writes, steers, or brings it back",
  () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      yield* f.client.FollowRepository({ input: "glass-demo/greeter" })

      const onPullRequest = Effect.fnUntraced(function* (gate: string, number: number) {
        const headBranch = `feature/${gate}`

        const pr = f.github.seedPullRequest({
          owner: "glass-demo",
          repo: "greeter",
          number,
          headBranch,
          base: { sha: "b0", files: {} },
          head: { sha: `h${number}`, files: {} },
        })

        const thread = yield* f.start(`hold:${gate}`)
        yield* f.transcript(thread.id, holding)
        gitIn(f.worktree(thread.name), "switch", "--quiet", "-c", headBranch)
        yield* f.release(gate)

        yield* f.client.WatchThreadPullRequests().pipe(
          Stream.filter((listed) =>
            listed.some(
              ({ threadId, state }) => threadId === thread.id && Predicate.isTagged(state, "Open"),
            ),
          ),
          Stream.runHead,
        )

        return { pr, threadId: thread.id }
      })

      const settledIds = (until: (ids: ReadonlyArray<string>) => boolean) =>
        f.client
          .WatchSettledThreads()
          .pipe(Stream.filter(until), Stream.runHead, Effect.map(Option.getOrThrow))

      const merge = (pr: FakePullRequest) =>
        Effect.sync(() => pr.edit({ state: "MERGED" })).pipe(
          Effect.andThen(f.client.ListPullRequests()),
        )

      const written = yield* onPullRequest("written", 7)
      yield* merge(written.pr)
      yield* settledIds((ids) => ids.includes(written.threadId))

      yield* f.send(written.threadId, "hold:again")
      yield* settledIds((ids) => !ids.includes(written.threadId))
      yield* f.release("again")
      yield* f.transcript(written.threadId, settled(2))

      const steered = yield* onPullRequest("steered", 8)
      yield* f.send(steered.threadId, "hold:late")
      yield* f.transcript(steered.threadId, holding)
      yield* merge(steered.pr)
      yield* f.client.Steer({
        threadId: steered.threadId,
        message: "Also this",
        images: [],
      })
      yield* f.release("late")
      yield* f.transcript(steered.threadId, settled(2))

      const broughtBack = yield* onPullRequest("brought-back", 9)
      yield* merge(broughtBack.pr)
      yield* settledIds((ids) => ids.includes(broughtBack.threadId))

      const settledAfterRestart = Effect.gen(function* () {
        const restarted = yield* f.restart
        yield* restarted.ListPullRequests()

        const merged = yield* restarted.WatchThreadPullRequests().pipe(
          Stream.filter(
            (listed) =>
              listed.length === 3 &&
              listed.every(({ state }) => Predicate.isTagged(state, "Merged")),
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        )

        const ids = yield* restarted.WatchSettledThreads().pipe(Stream.runHead)

        return { client: restarted, merged, ids: Option.getOrThrow(ids) }
      })

      const restarted = yield* settledAfterRestart
      assert.deepStrictEqual(restarted.ids, [broughtBack.threadId])

      assert.sameDeepMembers(
        restarted.merged.map(({ threadId, ref, url }) => ({ threadId, number: ref.number, url })),
        [written, steered, broughtBack].map(({ threadId, pr }) => ({
          threadId,
          number: pr.number,
          url: pr.url,
        })),
      )

      yield* restarted.client.BringBackThread({ threadId: broughtBack.threadId })
      assert.deepStrictEqual((yield* settledAfterRestart).ids, [])
    }),
)
