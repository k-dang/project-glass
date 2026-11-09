import { assert, it } from "@effect/vitest"
import {
  AgentStarted,
  FeedbackNote,
  SandboxPlace,
  TextPatch,
  UnsentFeedback,
  localPlace,
} from "@glass/contracts"
import { Effect, Option, Predicate, Stream } from "effect"
import { existsSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { agentsFixture, holding, repository, settled } from "../test/agentsFixture"
import { gitIn } from "../test/gitRepositories"
import { isolatedHome } from "../test/harness"

it.live("links a clone as the Local checkout of the GitHub repository it names, and keeps it", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
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
    assert.equal(yield* restarted.GetNewAgentDefaultBranch(onThisDevice), "main")
    assert.sameMembers(
      [...(yield* restarted.ListNewAgentBranches(onThisDevice))],
      ["main", "develop"],
    )
  }),
)

it.live("lists a Followed repository's branches from GitHub, for a Sandbox", () =>
  Effect.gen(function* () {
    const { github, client } = yield* agentsFixture
    const inSandbox = { place: SandboxPlace.make({ providerId: "fake" }), repository }
    const nowhere = { ...inSandbox, repository: { owner: "glass-demo", repo: "nowhere" } }
    const features = Array.from({ length: 150 }, (_, index) => `feature/${index}`)
    github.seedBranches(repository, {
      defaultBranch: "develop",
      branches: ["main", "develop", ...features],
    })

    assert.equal(yield* client.GetNewAgentDefaultBranch(inSandbox), "develop")

    const branches = yield* client.ListNewAgentBranches(inSandbox)
    assert.sameMembers([...branches], ["main", "develop", ...features])

    const missing = yield* client.ListNewAgentBranches(nowhere).pipe(Effect.flip)

    assert.equal(missing._tag, "GitHubUnavailable")

    const missingDefault = yield* client.GetNewAgentDefaultBranch(nowhere).pipe(Effect.flip)

    assert.equal(missingDefault._tag, "GitHubUnavailable")
  }),
)

it.live("starts an Agent in a worktree, on a new branch it names from its base", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    const agent = yield* f.start()
    const other = yield* f.start()
    const worktree = f.worktree(agent.name)

    assert.match(agent.name, /^agent\//)
    assert.notEqual(other.name, agent.name)
    assert.equal(gitIn(worktree, "branch", "--show-current"), agent.name)
    assert.equal(gitIn(worktree, "rev-parse", "HEAD"), f.clone.main)

    const [listed] = yield* f.client
      .WatchAgents()
      .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

    assert.deepStrictEqual(
      { id: listed?.id, place: listed?.place, repository: listed?.repository },
      { id: agent.id, place: localPlace, repository },
    )

    const { activities } = yield* f.client.ListActivity({ limit: 10 })
    assert.deepInclude(
      activities.map(({ activity }) => activity),
      AgentStarted.make({
        agentId: agent.id,
        name: agent.name,
        repository,
        machine: "local",
        engine: "pi",
        message: "Say hello",
      }),
    )
  }),
)

it.live(
  "removes an Agent's worktree and transcript, warning about changes and keeping its branch",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const agent = yield* f.start("hold:never")
      const worktree = f.worktree(agent.name)
      yield* f.transcript(agent.id, holding)

      const clean = yield* f.client.GetRemovalWarnings({ agentId: agent.id })
      assert.equal(clean.uncommittedChanges, "none")

      yield* Effect.promise(() => writeFile(join(worktree, "notes.txt"), "work in progress"))
      const dirty = yield* f.client.GetRemovalWarnings({ agentId: agent.id })
      assert.equal(dirty.uncommittedChanges, "some")

      yield* f.client.RemoveAgent({ agentId: agent.id })

      assert.isFalse(existsSync(worktree))
      assert.equal(
        gitIn(f.clone.checkout, "branch", "--list", agent.name).replace("*", "").trim(),
        agent.name,
      )
      assert.lengthOf(
        yield* f.client.WatchAgents().pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
        0,
      )

      const gone = yield* f.client
        .WatchTranscript({ agentId: agent.id })
        .pipe(Stream.runHead, Effect.flip)

      assert.equal(gone._tag, "AgentNotFound")
    }),
)

it.live(
  "diffs an Agent's files against its base, uncommitted work included, leaving git alone",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const agent = yield* f.start("Make changes")
      const worktree = f.worktree(agent.name)
      yield* f.transcript(agent.id, settled(1))

      yield* Effect.promise(async () => {
        await writeFile(join(worktree, "committed.txt"), "done\n")
        gitIn(worktree, "add", "committed.txt")
        gitIn(
          worktree,
          "-c",
          "user.name=Agent",
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
      const { files } = yield* f.client.GetAgentChanges({ agentId: agent.id })
      assert.deepStrictEqual(git(), before)
      assert.equal(before.branch, agent.name)
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
  "keeps an Agent's Feedback notes with the code they were left on until the Agent is removed",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const agent = yield* f.start("Make changes")
      const worktree = f.worktree(agent.name)
      yield* f.transcript(agent.id, settled(1))
      yield* Effect.promise(() => writeFile(join(worktree, "notes.txt"), "one\ntwo\n"))

      const read = yield* f.client.GetAgentChanges({ agentId: agent.id })
      assert.equal((yield* f.client.GetAgentChanges({ agentId: agent.id })).id, read.id)

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

      yield* f.client.SaveFeedbackNote({ agentId: agent.id, note })
      yield* f.client.SaveFeedbackNote({ agentId: agent.id, note: other })
      yield* f.client.SaveFeedbackNote({ agentId: agent.id, note: edited })
      yield* f.client.RemoveFeedbackNote({ agentId: agent.id, noteId: other.id })

      yield* Effect.promise(() => writeFile(join(worktree, "notes.txt"), "one\nthree\n"))
      assert.notEqual((yield* f.client.GetAgentChanges({ agentId: agent.id })).id, read.id)

      const restarted = yield* f.restart
      assert.deepStrictEqual((yield* restarted.ListFeedbackNotes({ agentId: agent.id })).notes, [
        edited,
      ])

      yield* restarted.RemoveAgent({ agentId: agent.id })
      const gone = yield* restarted.ListFeedbackNotes({ agentId: agent.id }).pipe(Effect.flip)
      assert.equal(gone._tag, "AgentNotFound")
    }),
)

it.live(
  "queues staged Feedback notes for the working Agent as one message, taking only those notes",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const agent = yield* f.start("hold:first")
      const agentId = agent.id
      yield* f.transcript(agentId, holding)

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

      for (const note of [capAttempts, keepError, later])
        yield* f.client.SaveFeedbackNote({ agentId, note })

      const staged = [capAttempts.id, keepError.id]
      yield* f.client.StageFeedbackNotes({ agentId, noteIds: staged })
      assert.deepStrictEqual((yield* f.client.ListFeedbackNotes({ agentId })).staged, staged)

      const sent = { agentId, message: "", images: [], feedback: staged }
      yield* f.client.SendMessage(sent)

      const { queued } = yield* f.watch(agentId, (transcript) => transcript.queued.length === 1)
      assert.deepStrictEqual(queued[0]?.feedback, [capAttempts, keepError])
      assert.deepStrictEqual(
        yield* f.client.ListFeedbackNotes({ agentId }),
        new UnsentFeedback({ notes: [later], staged: [] }),
      )

      const again = yield* f.client.SendMessage(sent).pipe(Effect.flip)
      assert.equal(again._tag, "AgentError")
      assert.lengthOf((yield* f.client.ListFeedbackNotes({ agentId })).notes, 1)

      yield* f.release("first")
      yield* f.transcript(agentId, settled(2))

      const restarted = yield* f.restart

      const { turns, queued: left } = yield* f.watch(
        agentId,
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
