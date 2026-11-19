import { assert, it } from "@effect/vitest"
import {
  ConversationStarted,
  FeedbackNote,
  SandboxPlace,
  TextPatch,
  UnsentFeedback,
  localPlace,
} from "@glass/contracts"
import { Effect, Option, Predicate, Stream } from "effect"
import { existsSync } from "node:fs"
import { mkdir, rename, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  conversationsFixture,
  conversationsFixtureWith,
  holding,
  repository,
  scriptedHost,
  settled,
} from "../test/conversationsFixture"
import { gitIn } from "../test/gitRepositories"
import { isolatedHome } from "../test/harness"

it.live("links a clone as the Local checkout of the GitHub repository it names, and keeps it", () =>
  Effect.gen(function* () {
    const f = yield* conversationsFixture
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
    assert.equal(yield* restarted.GetNewConversationDefaultBranch(onThisDevice), "main")
    assert.sameMembers(
      [...(yield* restarted.ListNewConversationBranches(onThisDevice))],
      ["main", "develop"],
    )
  }),
)

it.live("lists a Followed repository's branches from GitHub, for a Sandbox", () =>
  Effect.gen(function* () {
    const { github, client } = yield* conversationsFixture
    const inSandbox = { place: SandboxPlace.make({ providerId: "fake" }), repository }
    const nowhere = { ...inSandbox, repository: { owner: "glass-demo", repo: "nowhere" } }
    const features = Array.from({ length: 150 }, (_, index) => `feature/${index}`)
    github.seedBranches(repository, {
      defaultBranch: "develop",
      branches: ["main", "develop", ...features],
    })

    assert.equal(yield* client.GetNewConversationDefaultBranch(inSandbox), "develop")

    const branches = yield* client.ListNewConversationBranches(inSandbox)
    assert.sameMembers([...branches], ["main", "develop", ...features])

    const missing = yield* client.ListNewConversationBranches(nowhere).pipe(Effect.flip)

    assert.equal(missing._tag, "GitHubUnavailable")

    const missingDefault = yield* client.GetNewConversationDefaultBranch(nowhere).pipe(Effect.flip)

    assert.equal(missingDefault._tag, "GitHubUnavailable")
  }),
)

it.live("fails only the Turn sent while the agent host bundle is missing", () =>
  Effect.gen(function* () {
    const bundle = join(yield* isolatedHome, "agentHost.mjs")
    const f = yield* conversationsFixtureWith({ agentHostBundle: bundle })
    const conversation = yield* f.start()

    const [failed] = yield* f.transcript(conversation.id, settled(1))
    assert.equal(failed?.ended?.ending._tag, "Failed")

    yield* Effect.promise(() => symlink(scriptedHost, bundle))
    yield* f.send(conversation.id, "Say hello again")

    const turns = yield* f.transcript(conversation.id, settled(2))
    assert.equal(turns.at(-1)?.ended?.ending._tag, "Done")
  }),
)

it.live("starts a Conversation in a worktree, on a new branch it names from its base", () =>
  Effect.gen(function* () {
    const f = yield* conversationsFixture
    const conversation = yield* f.start()
    const other = yield* f.start()
    const worktree = f.worktree(conversation.name)

    assert.match(conversation.name, /^agent\//)
    assert.notEqual(other.name, conversation.name)
    assert.equal(gitIn(worktree, "branch", "--show-current"), conversation.name)
    assert.equal(gitIn(worktree, "rev-parse", "HEAD"), f.clone.main)

    const [listed] = yield* f.client
      .WatchConversations()
      .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

    assert.deepStrictEqual(
      { id: listed?.id, place: listed?.place, repository: listed?.repository },
      { id: conversation.id, place: localPlace, repository },
    )

    const { activities } = yield* f.client.ListActivity({ limit: 10 })
    assert.deepInclude(
      activities.map(({ activity }) => activity),
      ConversationStarted.make({
        conversationId: conversation.id,
        name: conversation.name,
        repository,
        machine: "local",
        harness: "pi",
        message: "Say hello",
      }),
    )
  }),
)

it.live(
  "removes a Conversation's worktree and transcript, warning about changes and keeping its branch",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationsFixture
      const conversation = yield* f.start("hold:never")
      const worktree = f.worktree(conversation.name)
      yield* f.transcript(conversation.id, holding)

      const clean = yield* f.client.GetRemovalWarnings({ conversationId: conversation.id })
      assert.equal(clean.uncommittedChanges, "none")

      yield* Effect.promise(() => writeFile(join(worktree, "notes.txt"), "work in progress"))
      const dirty = yield* f.client.GetRemovalWarnings({ conversationId: conversation.id })
      assert.equal(dirty.uncommittedChanges, "some")

      yield* f.client.RemoveConversation({ conversationId: conversation.id })

      assert.isFalse(existsSync(worktree))
      assert.equal(
        gitIn(f.clone.checkout, "branch", "--list", conversation.name).replace("*", "").trim(),
        conversation.name,
      )
      assert.lengthOf(
        yield* f.client.WatchConversations().pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
        0,
      )

      const gone = yield* f.client
        .WatchTranscript({ conversationId: conversation.id })
        .pipe(Stream.runHead, Effect.flip)

      assert.equal(gone._tag, "ConversationNotFound")
    }),
)

it.live(
  "diffs a Conversation's files against its base, uncommitted work included, leaving git alone",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationsFixture
      const conversation = yield* f.start("Make changes")
      const worktree = f.worktree(conversation.name)
      yield* f.transcript(conversation.id, settled(1))

      yield* Effect.promise(async () => {
        await writeFile(join(worktree, "committed.txt"), "done\n")
        gitIn(worktree, "add", "committed.txt")
        gitIn(
          worktree,
          "-c",
          "user.name=Conversation",
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
      const { files } = yield* f.client.GetConversationChanges({ conversationId: conversation.id })
      assert.deepStrictEqual(git(), before)
      assert.equal(before.branch, conversation.name)
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
  "keeps a Conversation's Feedback notes with the code they were left on until the Conversation is removed",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationsFixture
      const conversation = yield* f.start("Make changes")
      const worktree = f.worktree(conversation.name)
      yield* f.transcript(conversation.id, settled(1))
      yield* Effect.promise(() => writeFile(join(worktree, "notes.txt"), "one\ntwo\n"))

      const read = yield* f.client.GetConversationChanges({ conversationId: conversation.id })
      assert.equal(
        (yield* f.client.GetConversationChanges({ conversationId: conversation.id })).id,
        read.id,
      )

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

      const note = new FeedbackNote(fields)

      const other = new FeedbackNote({
        ...fields,
        id: "note-2",
        start: 2,
        code: "two",
        text: "Drop",
      })

      const edited = new FeedbackNote({ ...fields, text: "Say three and four" })

      yield* f.client.SaveFeedbackNote({ conversationId: conversation.id, note })
      yield* f.client.SaveFeedbackNote({ conversationId: conversation.id, note: other })
      yield* f.client.SaveFeedbackNote({ conversationId: conversation.id, note: edited })
      yield* f.client.RemoveFeedbackNote({ conversationId: conversation.id, noteId: other.id })

      yield* Effect.promise(() => writeFile(join(worktree, "notes.txt"), "one\nthree\n"))
      assert.notEqual(
        (yield* f.client.GetConversationChanges({ conversationId: conversation.id })).id,
        read.id,
      )

      const restarted = yield* f.restart
      assert.deepStrictEqual(
        (yield* restarted.ListFeedbackNotes({ conversationId: conversation.id })).notes,
        [edited],
      )

      yield* restarted.RemoveConversation({ conversationId: conversation.id })

      const gone = yield* restarted
        .ListFeedbackNotes({ conversationId: conversation.id })
        .pipe(Effect.flip)

      assert.equal(gone._tag, "ConversationNotFound")
    }),
)

it.live(
  "queues staged Feedback notes for the working Conversation as one message, taking only those notes",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationsFixture
      const conversation = yield* f.start("hold:first")
      const conversationId = conversation.id
      yield* f.transcript(conversationId, holding)

      const fields = {
        path: "src/retry.ts",
        side: "new",
        start: 2,
        end: 3,
        code: "attempts++\nreturn send()",
        changesId: "changes-1",
      } as const

      const capAttempts = new FeedbackNote({ ...fields, id: "note-1", text: "Cap the attempts" })
      const keepError = new FeedbackNote({ ...fields, id: "note-2", text: "Keep the last error" })
      const later = new FeedbackNote({ ...fields, id: "note-3", text: "Not staged yet" })

      for (const note of [capAttempts, keepError])
        yield* f.client.SaveFeedbackNote({ conversationId, note })

      const staged = [capAttempts.id, keepError.id]
      assert.deepStrictEqual(
        (yield* f.client.StageFeedbackNotes({ conversationId })).staged,
        staged,
      )
      yield* f.client.SaveFeedbackNote({ conversationId, note: later })

      const unstaged = { conversationId, message: "", images: [], feedback: [later.id] }
      assert.equal(
        (yield* f.client.SendMessage(unstaged).pipe(Effect.flip))._tag,
        "ConversationError",
      )

      const sent = { conversationId, message: "", images: [], feedback: staged }
      yield* f.client.SendMessage(sent)

      const { queued } = yield* f.watch(
        conversationId,
        (transcript) => transcript.queued.length === 1,
      )

      assert.deepStrictEqual(queued[0]?.feedback, [capAttempts, keepError])
      assert.deepStrictEqual(
        yield* f.client.ListFeedbackNotes({ conversationId }),
        new UnsentFeedback({ notes: [later], staged: [] }),
      )

      const again = yield* f.client.SendMessage(sent).pipe(Effect.flip)
      assert.equal(again._tag, "ConversationError")
      assert.lengthOf((yield* f.client.ListFeedbackNotes({ conversationId })).notes, 1)

      yield* f.release("first")
      yield* f.transcript(conversationId, settled(2))

      const restarted = yield* f.restart

      const { turns, queued: left } = yield* f.watch(
        conversationId,
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
  const f = yield* conversationsFixture
  const conversation = yield* f.start("hold:first")
  const conversationId = conversation.id
  yield* f.transcript(conversationId, holding)

  const fields = {
    path: "src/retry.ts",
    side: "old",
    start: 4,
    end: 5,
    code: "attempts++\nreturn send()",
    changesId: "changes-1",
  } as const

  const sent = [
    new FeedbackNote({ ...fields, id: "note-1", text: "Cap the attempts" }),
    new FeedbackNote({ ...fields, id: "note-2", changesId: "changes-0", text: "Keep the error" }),
  ]

  for (const note of sent) yield* f.client.SaveFeedbackNote({ conversationId, note })
  yield* f.client.StageFeedbackNotes({ conversationId })
  yield* f.client.SendMessage({
    conversationId,
    message: "",
    images: [],
    feedback: ["note-1", "note-2"],
  })

  const { queued } = yield* f.watch(conversationId, (transcript) => transcript.queued.length === 1)
  const queuedId = queued[0]!.id

  const newer = new FeedbackNote({ ...fields, id: "note-3", text: "Newer" })
  yield* f.client.SaveFeedbackNote({ conversationId, note: newer })
  yield* f.client.StageFeedbackNotes({ conversationId })

  return { f, conversationId, sent, newer, queuedId }
})

it.live(
  "returns a canceled Queued message's Feedback notes beside newer ones, once and durably",
  () =>
    Effect.gen(function* () {
      const { f, conversationId, sent, newer, queuedId } = yield* queuedFeedback
      const cancel = { conversationId, queuedMessageId: queuedId }
      const restored = new UnsentFeedback({ notes: [newer, ...sent], staged: [newer.id] })

      assert.deepStrictEqual(yield* f.client.CancelQueuedMessage(cancel), restored)
      yield* f.watch(conversationId, (transcript) => transcript.queued.length === 0)
      assert.deepStrictEqual(yield* f.client.CancelQueuedMessage(cancel), restored)

      const restarted = yield* f.restart
      assert.deepStrictEqual(yield* restarted.ListFeedbackNotes({ conversationId }), restored)
    }),
)

it.live("refuses to cancel a Queued message whose Turn started, leaving its feedback sent", () =>
  Effect.gen(function* () {
    const { f, conversationId, sent, newer, queuedId } = yield* queuedFeedback

    yield* f.release("first")
    yield* f.transcript(conversationId, settled(2))

    const late = yield* f.client
      .CancelQueuedMessage({ conversationId, queuedMessageId: queuedId })
      .pipe(Effect.flip)

    assert.equal(late._tag, "QueuedMessageStarted")
    assert.deepStrictEqual(
      yield* f.client.ListFeedbackNotes({ conversationId }),
      new UnsentFeedback({ notes: [newer], staged: [newer.id] }),
    )
    assert.deepStrictEqual((yield* f.transcript(conversationId, settled(2)))[1]?.feedback, sent)
  }),
)

it.live("lists a Conversation as working while its Turn runs, until the Turn ends", () =>
  Effect.gen(function* () {
    const f = yield* conversationsFixture

    const working = (until: (ids: ReadonlyArray<string>) => boolean) =>
      f.client.WatchWorkingConversations().pipe(Stream.filter(until), Stream.runHead)

    const conversation = yield* f.start("hold:first")
    yield* f.transcript(conversation.id, holding)
    yield* working((ids) => ids.includes(conversation.id))

    yield* f.release("first")
    yield* f.transcript(conversation.id, settled(1))
    yield* working((ids) => !ids.includes(conversation.id))
  }),
)

it.live("finds a Conversation's PR from the branch its agent left checked out, not a fork's", () =>
  Effect.gen(function* () {
    const f = yield* conversationsFixture
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

    const conversation = yield* f.start("hold:first")
    yield* f.transcript(conversation.id, holding)
    gitIn(f.worktree(conversation.name), "switch", "--quiet", "-c", "feature/greeting")
    yield* f.release("first")

    const [found] = yield* f.client.WatchConversationPullRequests().pipe(
      Stream.map((listed) =>
        listed.filter(({ conversationId }) => conversationId === conversation.id),
      ),
      Stream.filter((listed) => listed.length > 0),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    )

    assert.equal(found?.pullRequest.ref.number, 7)

    const [listed] = yield* f.client
      .WatchConversations()
      .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

    assert.equal(listed?.branch, "feature/greeting")
  }),
)
