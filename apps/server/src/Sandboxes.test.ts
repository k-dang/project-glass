import { assert, it } from "@effect/vitest"
import {
  ChangedFile,
  LineNote,
  FollowedRepository,
  incompatibleExplanation,
  PartSet,
  PermissionRequestPart,
  SandboxPlace,
  SandboxProviderInfo,
  type SandboxStatus,
  TextPart,
  TextPatch,
  type Transcript,
  type Turn,
  TurnCutOff,
  TurnDone,
  type TurnEnding,
  TurnEnded,
  TurnStopped,
} from "@glass/contracts"
import { DateTime, Duration, Effect, Fiber, Option, Predicate, Stream } from "effect"
import { TestClock } from "effect/testing"
import { resolve } from "node:path"
import { threadServicesFixture } from "../test/threadServicesFixture"
import { withWatchedClock } from "../test/deadlines"
import { HOST_PROTOCOL } from "./agentHost/protocol"
import { eventually } from "../test/eventually"
import { steps } from "../test/inProcessSandboxes"
import { SANDBOX_DEADLINES } from "./sandboxCalls"

type Fixture = Effect.Success<typeof threadServicesFixture>

const sandbox = SandboxPlace.make({ providerId: "fake" })

const end = Effect.fnUntraced(function* (
  turn: Effect.Success<Fixture["started"]>,
  ending: TurnEnding = TurnDone.make({}),
) {
  yield* turn.emit(
    TurnEnded.make({ turnId: turn.turnId, ended: { at: yield* DateTime.now, ending } }),
  )
})

const settled =
  (count: number) =>
  ({ turns }: Transcript) =>
    turns.length === count && turns.every((turn) => turn.ended !== null)

const failedReason = ({ turns }: Transcript) => {
  const ending = turns.at(-1)?.ended?.ending

  return Predicate.isTagged(ending, "Failed") ? ending.reason : ending?._tag
}

const texts = (turn: Turn | undefined) =>
  turn?.parts.flatMap((part) => (Predicate.isTagged(part, "Text") ? [part.text] : [])) ?? []

const reply = (turn: Effect.Success<Fixture["started"]>, said: ReadonlyArray<string>, from = 0) =>
  Effect.forEach(said, (text, index) =>
    turn.emit(
      PartSet.make({ turnId: turn.turnId, index: from + index, part: TextPart.make({ text }) }),
    ),
  )

const waitingPermission = PermissionRequestPart.make({
  requestId: "request-1",
  toolName: "Bash",
  inputSummary: "A tool request",
  input: "{}",
  status: "waiting",
  reason: null,
})

const afterRetries = (f: Fixture, threadId: string, until: (transcript: Transcript) => boolean) =>
  eventually(
    Effect.gen(function* () {
      yield* TestClock.adjust("1 second")
      const transcript = yield* f.transcript(threadId, ({ turns }) => turns.length > 0)
      assert.isTrue(until(transcript))

      return transcript
    }),
  )

const say = (message: string) => ({ message, images: [] })

const createSandboxed = (f: Fixture) => f.create(null, "pi", sandbox)

const removed = (f: Fixture, threadId: string) =>
  eventually(Effect.sync(() => assert.include(f.sandboxes.events, `removed ${threadId}`)))

it.live("shows each step of making a Sandbox, then runs the first message in it", () =>
  Effect.gen(function* () {
    const f = yield* threadServicesFixture

    assert.deepStrictEqual(f.sandboxProviders, [
      new SandboxProviderInfo({
        id: "fake",
        name: "Fake Sandboxes",
        harnesses: ["claude-code", "pi"],
      }),
    ])

    f.sandboxes.configure({ holdAt: steps[0] })
    const thread = yield* createSandboxed(f)
    assert.deepStrictEqual(thread.place, sandbox)

    for (const [index, step] of steps.entries()) {
      yield* f.transcript(thread.id, ({ status }) => status === step)
      const next = steps[index + 1]
      f.sandboxes.configure(next === undefined ? {} : { holdAt: next })
    }

    const turn = yield* f.started
    assert.equal(turn.threadId, thread.id)
    yield* end(turn)

    const done = yield* f.transcript(thread.id, settled(1))
    assert.isNull(done.status)
    assert.deepStrictEqual(done.turns[0]?.ended?.ending, TurnDone.make({}))
  }),
)

it.live("offers a Sandbox only the Agent harnesses its provider runs", () =>
  Effect.gen(function* () {
    const f = yield* threadServicesFixture
    f.sandboxes.configure({ harnesses: ["pi"] })
    const { threads, sandboxProviders } = yield* f.restart

    assert.deepStrictEqual(sandboxProviders, [
      new SandboxProviderInfo({ id: "fake", name: "Fake Sandboxes", harnesses: ["pi"] }),
    ])

    const refused = yield* threads
      .create({
        repository: new FollowedRepository({ owner: "glass-test", repo: "greeter" }),
        baseBranch: "main",
        message: "Start",
        images: [],
        harness: "claude-code",
        model: null,
        effort: null,
        permissionMode: null,
        place: sandbox,
        skillPacks: [],
        localSkills: false,
      })
      .pipe(Effect.flip)

    assert.equal(refused.message, "This place doesn't run that Agent harness. Pick another.")
  }),
)

it.live("deletes a Sandbox that fails part-way, failing the first message safely", () =>
  Effect.gen(function* () {
    const f = yield* threadServicesFixture
    f.sandboxes.configure({ failAt: steps[0] })
    const thread = yield* createSandboxed(f)

    const failed = yield* f.transcript(thread.id, settled(1))
    assert.equal(
      failedReason(failed),
      "Couldn't create the Sandbox. Try again; Glass's backend log has the details.",
    )
    yield* removed(f, thread.id)
  }),
)

it.live("fails with the login a Sandbox needs and the command that fixes it", () =>
  Effect.gen(function* () {
    const f = yield* threadServicesFixture
    f.sandboxes.configure({ missingLogin: { login: "fake-cloud", fix: "fake-cloud login" } })
    const thread = yield* createSandboxed(f)

    assert.equal(
      failedReason(yield* f.transcript(thread.id, settled(1))),
      "Fake Sandboxes needs your fake-cloud login. Run fake-cloud login, then try again.",
    )
  }),
)

it.live(
  "refuses a Sandbox when there's no room, and makes one when the message is sent again",
  () =>
    Effect.gen(function* () {
      const f = yield* threadServicesFixture
      f.sandboxes.configure({ noCapacity: "Fake Sandboxes are full." })
      const thread = yield* createSandboxed(f)

      assert.equal(
        failedReason(yield* f.transcript(thread.id, settled(1))),
        "Fake Sandboxes are full. Try again in a little while.",
      )

      f.sandboxes.configure({})
      yield* f.threads.send(thread.id, say("Try again"))
      yield* end(yield* f.started)
      assert.equal(failedReason(yield* f.transcript(thread.id, settled(2))), "Done")
    }),
)

it.live("keeps a Thread whose Sandbox can't be deleted yet, saying which login that needs", () =>
  Effect.gen(function* () {
    const f = yield* threadServicesFixture
    const thread = yield* createSandboxed(f)
    yield* end(yield* f.started)
    yield* f.transcript(thread.id, settled(1))

    f.sandboxes.configure({ missingLogin: { login: "fake-cloud", fix: "fake-cloud login" } })
    const refused = yield* f.threads.remove(thread.id).pipe(Effect.flip)
    assert.equal(
      refused.message,
      "Fake Sandboxes needs your fake-cloud login. Run fake-cloud login, then try again.",
    )
    assert.notInclude(f.sandboxes.events, `removed ${thread.id}`)
    yield* f.threads.unsent(thread.id)

    f.sandboxes.configure({})
    yield* f.threads.remove(thread.id)
    assert.include(f.sandboxes.events, `removed ${thread.id}`)
  }),
)

it.live("ends a Sandbox's agent host before deleting the Sandbox", () =>
  Effect.gen(function* () {
    const f = yield* threadServicesFixture
    const thread = yield* createSandboxed(f)
    yield* end(yield* f.started)
    yield* f.transcript(thread.id, settled(1))

    yield* f.threads.remove(thread.id)
    assert.deepStrictEqual(f.sandboxes.events, [`ended ${thread.id}`, `removed ${thread.id}`])
  }),
)

it.live("deletes a Sandbox still being made when its Thread is removed", () =>
  Effect.gen(function* () {
    const f = yield* threadServicesFixture
    f.sandboxes.configure({ holdAt: steps[0] })
    const thread = yield* createSandboxed(f)
    yield* f.transcript(thread.id, ({ status }) => status === steps[0])

    yield* f.threads.remove(thread.id)
    yield* removed(f, thread.id)
  }),
)

it.live("shows no changes or files for a Sandbox still being made, without waiting on it", () =>
  Effect.gen(function* () {
    const f = yield* threadServicesFixture
    f.sandboxes.configure({ holdAt: steps[0] })
    const thread = yield* createSandboxed(f)
    yield* f.transcript(thread.id, ({ status }) => status === steps[0])

    assert.isEmpty((yield* f.threads.changes(thread.id)).files)
    assert.isEmpty(yield* f.threads.files(thread.id))
    assert.equal((yield* f.threads.removalWarnings(thread.id)).uncommittedChanges, "none")
    assert.isEmpty(f.changesAsked)

    f.sandboxes.configure({})
    yield* end(yield* f.started)
    yield* f.transcript(thread.id, settled(1))
    yield* f.threads.changes(thread.id)
    assert.lengthOf(f.changesAsked, 1)
  }),
)

it.live("deletes a Sandbox still being made when Glass quits, and makes a new one after", () =>
  Effect.gen(function* () {
    const f = yield* threadServicesFixture
    f.sandboxes.configure({ holdAt: steps[0] })
    const thread = yield* createSandboxed(f)
    yield* f.transcript(thread.id, ({ status }) => status === steps[0])

    const { threads } = yield* f.restart
    yield* removed(f, thread.id)

    f.sandboxes.configure({})
    yield* threads.send(thread.id, say("Again"))
    const again = yield* f.started
    assert.equal(again.input.message, "Again")
    yield* end(again)
    assert.equal(failedReason(yield* f.transcript(thread.id, settled(2), threads)), "Done")
  }),
)

it.live("Steers and stops a Thread's Turns in its Sandbox, and shows its changes there", () =>
  Effect.gen(function* () {
    const f = yield* threadServicesFixture
    const thread = yield* createSandboxed(f)
    const turn = yield* f.started

    yield* f.threads.steer(thread.id, say("Change course"))
    assert.deepStrictEqual(f.steers, [{ threadId: thread.id, message: "Change course" }])

    yield* f.threads.stop(thread.id)
    assert.deepStrictEqual(f.stops, [thread.id])
    yield* end(turn, TurnStopped.make({}))
    yield* f.transcript(thread.id, settled(1))

    const notes = new ChangedFile({
      path: "notes.txt",
      previousPath: null,
      changeType: "added",
      additions: 1,
      deletions: 0,
      patch: TextPatch.make({ hunks: "@@ -0,0 +1 @@\n+hi" }),
    })

    yield* f.setChanges({ files: [notes], uncommitted: true })
    assert.deepStrictEqual((yield* f.threads.changes(thread.id)).files, [notes])
    assert.deepStrictEqual(f.changesAsked, [
      { folder: resolve("greeter"), baseRef: "refs/remotes/origin/main" },
    ])
  }),
)

it.live("warns before removing a Sandbox Thread with uncommitted work in its Sandbox", () =>
  Effect.gen(function* () {
    const f = yield* threadServicesFixture
    const thread = yield* createSandboxed(f)
    yield* end(yield* f.started)
    yield* f.transcript(thread.id, settled(1))

    assert.equal((yield* f.threads.removalWarnings(thread.id)).uncommittedChanges, "none")

    yield* f.setChanges({ files: [], uncommitted: true })
    assert.equal((yield* f.threads.removalWarnings(thread.id)).uncommittedChanges, "some")

    yield* f.sandboxes.stopHost(thread.id)
    assert.equal((yield* f.threads.removalWarnings(thread.id)).uncommittedChanges, "unchecked")
  }),
)

const sandboxOf = (threads: Fixture["threads"], threadId: string) =>
  threads.watch().pipe(
    Stream.map((listed) => listed.find(({ id }) => id === threadId)?.sandbox ?? null),
    Stream.filter((status): status is SandboxStatus => status !== null),
  )

it.live(
  "makes a Thread read-only once its Sandbox is deleted, and removes it without a warning",
  () =>
    Effect.gen(function* () {
      const f = yield* threadServicesFixture
      const thread = yield* createSandboxed(f)
      yield* end(yield* f.started)
      yield* f.transcript(thread.id, settled(1))

      yield* f.sandboxes.reclaim(thread.id)
      const relaunched = yield* f.restart
      yield* sandboxOf(relaunched.threads, thread.id).pipe(
        Stream.filter(({ reach }) => reach === "deleted"),
        Stream.runHead,
      )

      const refused = yield* relaunched.threads
        .send(thread.id, say("Still there?"))
        .pipe(Effect.flip)

      assert.equal(
        refused.message,
        "This Thread's Sandbox was deleted, so it can't take messages. Its transcript stays until you remove the Thread.",
      )

      const { threads } = yield* f.restart

      const [listed] = yield* threads.watch().pipe(Stream.runHead, Effect.map(Option.getOrThrow))

      assert.equal(listed?.sandbox?.reach, "deleted")
      assert.equal(failedReason(yield* f.transcript(thread.id, settled(1), threads)), "Done")
      assert.equal((yield* threads.removalWarnings(thread.id)).uncommittedChanges, "none")

      yield* threads.remove(thread.id)
      assert.deepStrictEqual(
        yield* threads.watch().pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
        [],
      )
    }),
)

it.effect(
  "extends a Sandbox ahead of expiry up to its cap, then makes its Thread read-only once it expires",
  () =>
    Effect.gen(function* () {
      const f = yield* threadServicesFixture
      f.sandboxes.configure({ extensionMillis: 1000, maxLifetimeMillis: 3000 })
      const thread = yield* createSandboxed(f)
      yield* end(yield* f.started)

      const note = new LineNote({
        id: "note",
        path: "notes.txt",
        side: "new",
        start: 1,
        end: 1,
        code: "hi",
        changesId: "read",
        text: "Say hello",
      })

      yield* f.threads.saveFeedbackNote(thread.id, note)

      for (const expiry of [1000, 1500, 2000, 2500, 3000]) {
        yield* sandboxOf(f.threads, thread.id).pipe(
          Stream.filter(
            ({ expiresAt }) => expiresAt !== null && DateTime.toEpochMillis(expiresAt) === expiry,
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        )
        yield* TestClock.adjust(500)
      }

      const expired = yield* eventually(
        Effect.gen(function* () {
          yield* TestClock.adjust(500)

          const status = yield* sandboxOf(f.threads, thread.id).pipe(
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          )

          assert.equal(status.reach, "expired")

          return status
        }),
      )

      assert.equal(expired.expiresAt && DateTime.toEpochMillis(expired.expiresAt), 3000)

      const refused = yield* f.threads.send(thread.id, say("Still there?")).pipe(Effect.flip)

      assert.equal(
        refused.message,
        "This Thread's Sandbox expired, so it can't take messages. Its transcript stays until you remove the Thread.",
      )
      assert.deepStrictEqual((yield* f.threads.feedbackNotes(thread.id)).notes, [note])
    }),
)

it.effect("keeps a Thread's Sandbox gone, though its host still answers", () =>
  Effect.gen(function* () {
    const f = yield* threadServicesFixture
    const thread = yield* createSandboxed(f)
    yield* end(yield* f.started)
    yield* f.transcript(thread.id, settled(1))

    f.sandboxes.setGone(thread.id, true)
    yield* TestClock.adjust("1 day")
    yield* sandboxOf(f.threads, thread.id).pipe(
      Stream.filter(({ reach }) => reach === "deleted"),
      Stream.runHead,
    )

    f.sandboxes.setGone(thread.id, false)
    const relaunched = yield* f.restart

    const status = yield* sandboxOf(relaunched.threads, thread.id).pipe(
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    )

    assert.equal(status.reach, "deleted")

    const refused = yield* relaunched.threads.send(thread.id, say("Still there?")).pipe(Effect.flip)

    assert.include(refused.message, "deleted")
  }),
)

it.effect(
  "follows a Sandbox's host again after a dropped connection, missing and repeating nothing",
  () =>
    Effect.gen(function* () {
      const f = yield* threadServicesFixture
      const thread = yield* createSandboxed(f)
      const turn = yield* f.started
      yield* reply(turn, ["one"])
      yield* f.transcript(thread.id, ({ turns }) => texts(turns[0]).length === 1)

      yield* f.sandboxes.dropConnections(thread.id)
      yield* reply(turn, ["two"], 1)
      yield* end(turn)

      const [done] = (yield* afterRetries(f, thread.id, settled(1))).turns
      assert.deepStrictEqual(texts(done), ["one", "two"])
      assert.deepStrictEqual(done?.ended?.ending, TurnDone.make({}))
    }),
)

it.effect(
  "cuts off a Sandbox's running Turn when its host restarts, keeping its transcript, then follows the new host from its start",
  () =>
    Effect.gen(function* () {
      const f = yield* threadServicesFixture
      const thread = yield* createSandboxed(f)
      const said = ["one", "two", "three", "four", "five"]
      const first = yield* f.started
      yield* reply(first, said)
      yield* first.emit(
        PartSet.make({ turnId: first.turnId, index: said.length, part: waitingPermission }),
      )
      yield* f.transcript(thread.id, ({ turns }) => turns[0]?.parts.length === said.length + 1)

      yield* f.sandboxes.restartHost(thread.id)

      const [cutOff] = (yield* afterRetries(f, thread.id, ({ turns }) => turns[0]?.ended !== null))
        .turns

      assert.deepStrictEqual(cutOff?.ended?.ending, TurnCutOff.make({}))
      assert.deepStrictEqual(texts(cutOff), said)

      yield* f.threads.send(thread.id, say("Again"))
      const second = yield* f.started
      yield* reply(second, ["six"])
      yield* end(second)

      const [, done] = (yield* f.transcript(thread.id, settled(2))).turns
      assert.deepStrictEqual(texts(done), ["six"])
    }),
)

for (const [spoken, kind] of [
  ["a later protocol", { kind: "versioned", protocol: HOST_PROTOCOL + 1 }],
  ["no protocol", { kind: "unversioned" }],
] as const)
  it.effect(
    `keeps a Thread read-only while its Sandbox's host speaks ${spoken}, cutting off its Turn, until a compatible host answers`,
    () =>
      Effect.gen(function* () {
        const f = yield* threadServicesFixture
        const thread = yield* createSandboxed(f)
        yield* reply(yield* f.started, ["one"])
        yield* f.transcript(thread.id, ({ turns }) => texts(turns[0]).length === 1)

        yield* f.sandboxes.restartHost(thread.id, kind)

        const [cutOff] = (yield* afterRetries(
          f,
          thread.id,
          ({ turns }) => turns[0]?.ended !== null,
        )).turns

        assert.deepStrictEqual(cutOff?.ended?.ending, TurnCutOff.make({}))
        assert.deepStrictEqual(texts(cutOff), ["one"])

        const status = yield* sandboxOf(f.threads, thread.id).pipe(
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        )

        assert.equal(status.reach, "incompatible")

        yield* f.threads.send(thread.id, say("Still there?"))
        assert.equal(
          failedReason(yield* f.transcript(thread.id, settled(2))),
          incompatibleExplanation,
        )

        yield* f.sandboxes.restartHost(thread.id)
        yield* f.threads.send(thread.id, say("Back?"))
        yield* end(yield* f.started)
        assert.equal(failedReason(yield* f.transcript(thread.id, settled(3))), "Done")
      }),
  )

it.effect("runs a message sent after Glass relaunches on its Sandbox's replacement host", () =>
  Effect.gen(function* () {
    const f = yield* threadServicesFixture
    const thread = yield* createSandboxed(f)
    yield* end(yield* f.started)
    yield* f.transcript(thread.id, settled(1))

    yield* f.sandboxes.restartHost(thread.id)
    const { threads } = yield* f.restart
    yield* threads.send(thread.id, say("Again"))
    yield* end(yield* f.started)

    assert.equal(failedReason(yield* f.transcript(thread.id, settled(2), threads)), "Done")
  }),
)

const tookTooLong = (action: string) =>
  `Fake Sandboxes didn't answer in time, so Glass couldn't ${action}. Try again.`

const abandoned = (f: Fixture, call: string) =>
  eventually(Effect.sync(() => assert.include(f.sandboxes.events, `abandoned ${call}`)))

it.effect(
  "stops waiting for a Sandbox provider's models at 30 seconds, and not a millisecond sooner",
  () =>
    withWatchedClock(SANDBOX_DEADLINES.models, (deadlineSet) =>
      Effect.gen(function* () {
        const f = yield* threadServicesFixture
        f.sandboxes.configure({ stall: "models" })

        const listing = yield* Effect.forkChild(f.threads.models("pi", sandbox).pipe(Effect.flip))

        yield* deadlineSet
        yield* TestClock.adjust(Duration.millis(29_999))
        assert.isUndefined(listing.pollUnsafe())

        yield* TestClock.adjust(Duration.millis(1))
        assert.equal(
          (yield* Fiber.join(listing)).message,
          tookTooLong("list what its Sandboxes offer"),
        )
        assert.include(f.sandboxes.events, "abandoned models")
      }),
    ),
)

it.effect(
  "fails the first message when a new Sandbox's address never comes, deleting the half-built Sandbox",
  () =>
    withWatchedClock(SANDBOX_DEADLINES.startHost, (deadlineSet) =>
      Effect.gen(function* () {
        const f = yield* threadServicesFixture
        f.sandboxes.configure({ stall: "target" })
        const thread = yield* createSandboxed(f)

        yield* deadlineSet
        yield* TestClock.adjust(SANDBOX_DEADLINES.startHost)
        yield* abandoned(f, "target")

        f.sandboxes.configure({})
        assert.equal(
          failedReason(yield* f.transcript(thread.id, settled(1))),
          "The agent in the Sandbox didn't start. Try again.",
        )
        yield* removed(f, thread.id)

        yield* f.threads.send(thread.id, say("Again"))
        yield* end(yield* f.started)
        assert.equal(failedReason(yield* f.transcript(thread.id, settled(2))), "Done")
      }),
    ),
)

it.effect(
  "keeps a Thread whose Sandbox provider never finishes deleting it, so removing it again can finish",
  () =>
    withWatchedClock(SANDBOX_DEADLINES.remove, (deadlineSet) =>
      Effect.gen(function* () {
        const f = yield* threadServicesFixture
        const thread = yield* createSandboxed(f)
        yield* end(yield* f.started)
        yield* f.transcript(thread.id, settled(1))

        f.sandboxes.configure({ stall: "remove" })

        const removing = yield* Effect.forkChild(f.threads.remove(thread.id).pipe(Effect.flip))

        yield* deadlineSet
        yield* TestClock.adjust(SANDBOX_DEADLINES.remove)
        assert.equal((yield* Fiber.join(removing)).message, tookTooLong("delete the Sandbox"))
        assert.include(f.sandboxes.events, "abandoned remove")
        assert.notInclude(f.sandboxes.events, `removed ${thread.id}`)
        yield* f.threads.unsent(thread.id)

        f.sandboxes.configure({})
        yield* f.threads.remove(thread.id)
        assert.include(f.sandboxes.events, `removed ${thread.id}`)
      }),
    ),
)

it.effect(
  "deletes a half-built Sandbox whose deletion timed out before making another for the next message",
  () =>
    withWatchedClock(SANDBOX_DEADLINES.remove, (deadlineSet) =>
      Effect.gen(function* () {
        const f = yield* threadServicesFixture
        f.sandboxes.configure({ failAt: steps[0], stall: "remove" })
        const thread = yield* createSandboxed(f)

        yield* deadlineSet
        yield* TestClock.adjust(SANDBOX_DEADLINES.remove)
        yield* f.transcript(thread.id, settled(1))
        assert.include(f.sandboxes.events, "abandoned remove")
        assert.notInclude(f.sandboxes.events, `removed ${thread.id}`)

        f.sandboxes.configure({})
        yield* f.threads.send(thread.id, say("Again"))
        yield* end(yield* f.started)
        assert.equal(failedReason(yield* f.transcript(thread.id, settled(2))), "Done")
        assert.include(f.sandboxes.events, `removed ${thread.id}`)
      }),
    ),
)

it.effect(
  "gives up a Sandbox renewal its provider never answers, and renews it on a later try",
  () =>
    Effect.gen(function* () {
      const f = yield* threadServicesFixture
      f.sandboxes.configure({ stall: "extend" })
      const thread = yield* createSandboxed(f)
      yield* end(yield* f.started)
      yield* f.transcript(thread.id, settled(1))

      yield* eventually(
        Effect.gen(function* () {
          yield* TestClock.adjust("1 second")
          assert.include(f.sandboxes.events, "abandoned extend")
        }),
      )

      f.sandboxes.configure({})

      const renewed = yield* eventually(
        Effect.gen(function* () {
          yield* TestClock.adjust("1 second")

          return yield* sandboxOf(f.threads, thread.id).pipe(
            Stream.runHead,
            Effect.map(Option.getOrThrow),
            Effect.filterOrFail(({ expiresAt }) => expiresAt !== null),
          )
        }),
      )

      assert.equal(renewed.reach, "reachable")
    }),
)
