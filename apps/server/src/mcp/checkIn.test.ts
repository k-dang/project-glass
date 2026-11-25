import { assert, describe, it } from "@effect/vitest"
import {
  AnswerState,
  CheckedIn,
  CheckInApprove,
  CheckInApproved,
  CheckInFeedback,
  CheckInNoChanges,
  CheckInReplaced,
  CheckInSendFeedback,
  CheckInStarted,
  LineNote,
  ListedAnswer,
  type InboxItems,
  QuestionSetAside,
  QuestionWaiting,
} from "@glass/contracts"
import { Effect, Exit, Option, Predicate, Schema, Scope, Stream } from "effect"
import { writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitIn } from "../../test/gitRepositories"
import { isolatedHome, startBackend } from "../../test/harness"
import { inboxWhen } from "../../test/inboxWhen"
import { connectMcp, toolText } from "../../test/mcpClient"

type Backend = Effect.Success<ReturnType<typeof startBackend>>

type Mcp = Effect.Success<ReturnType<typeof connectMcp>>

const checkIns = (items: InboxItems) => items.filter((item) => Predicate.isTagged(item, "CheckIn"))

const started = Schema.decodeUnknownSync(CheckInStarted)

const answerState = Schema.decodeUnknownSync(AnswerState)

const shownCheckIn = (client: Backend["client"], id: string) =>
  inboxWhen(client, (items) => checkIns(items).some((item) => item.id === id)).pipe(
    Effect.map((items) =>
      Option.getOrThrow(Option.fromNullishOr(checkIns(items).find((item) => item.id === id))),
    ),
  )

const temporaryFolder = Effect.promise(() => mkdtemp(join(tmpdir(), "glass-check-in-")))

const repositoryWithWork = Effect.gen(function* () {
  const folder = yield* temporaryFolder

  gitIn(folder, "init", "--quiet", "--initial-branch=main")
  writeFileSync(join(folder, "retry.ts"), "export const attempts = 1\n")
  gitIn(folder, "add", ".")
  gitIn(folder, "commit", "--quiet", "-m", "Start")
  gitIn(folder, "switch", "--quiet", "-c", "work")
  writeFileSync(join(folder, "retry.ts"), "export const attempts = 3\n")
  gitIn(folder, "commit", "--quiet", "-am", "Retry more")
  writeFileSync(join(folder, "backoff.ts"), "export const delay = 100\n")

  return folder
})

const start = Effect.gen(function* () {
  const backend = yield* startBackend({})
  const mcp = yield* connectMcp(backend.baseUrl, yield* backend.outsideAgents.issue("Claude Code"))

  return { ...backend, mcp }
})

const checkIn = (mcp: Mcp, args: Readonly<Record<string, string>>) =>
  mcp.call("check_in", args).pipe(Effect.map(({ structuredContent }) => started(structuredContent)))

const checkedIn = (mcp: Mcp, args: Readonly<Record<string, string>>) =>
  checkIn(mcp, args).pipe(
    Effect.map((result) => {
      assert.ok(Schema.is(CheckedIn)(result))

      return result.checkInId
    }),
  )

const readAnswer = (mcp: Mcp, id: string) =>
  mcp
    .call("read_answer", { id })
    .pipe(Effect.map(({ structuredContent }) => answerState(structuredContent)))

const listed = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(ListedAnswer) }))

const listAnswers = (mcp: Mcp) =>
  mcp
    .call("list_answers", {})
    .pipe(
      Effect.map(({ structuredContent }) =>
        listed(structuredContent).items.map(({ id, state }) => [id, state]),
      ),
    )

const noteOn = (changesId: string, text: string) =>
  new LineNote({
    id: "note-1",
    path: "retry.ts",
    side: "new",
    start: 1,
    end: 1,
    code: "export const attempts = 3",
    changesId,
    text,
  })

describe("check_in", () => {
  it.live("returns at once, shows the changes in the Inbox, and hands back the feedback", () =>
    Effect.gen(function* () {
      const { client, mcp } = yield* start
      const folder = yield* repositoryWithWork

      const checkInId = yield* checkedIn(mcp, {
        folder,
        baseRef: "main",
        summary: "Retry three times",
      })

      const waiting = yield* shownCheckIn(client, checkInId)

      assert.equal(waiting.summary, "Retry three times")
      assert.equal(waiting.askedBy, "Claude Code")
      assert.deepStrictEqual(yield* readAnswer(mcp, checkInId), QuestionWaiting.make({}))

      const changes = yield* client.GetCheckInChanges({ checkInId })

      assert.deepStrictEqual(
        changes.files.map(({ path }) => path),
        ["backoff.ts", "retry.ts"],
      )

      yield* client.SaveCheckInNote({
        checkInId,
        note: noteOn(changes.id, "Read this from config"),
      })
      yield* client.AnswerCheckIn({
        checkInId,
        answer: CheckInSendFeedback.make({ message: "Close, one thing" }),
      })

      assert.deepStrictEqual(
        yield* readAnswer(mcp, checkInId),
        CheckInFeedback.make({
          message: "Close, one thing",
          notes: [
            {
              path: "retry.ts",
              side: "new",
              start: 1,
              end: 1,
              code: "export const attempts = 3",
              text: "Read this from config",
              outdated: false,
            },
          ],
        }),
      )
      yield* inboxWhen(client, (items) => checkIns(items).length === 0)
    }),
  )

  it.live("replaces a waiting Check-in from the same folder, carrying its notes over", () =>
    Effect.gen(function* () {
      const { client, mcp } = yield* start
      const folder = yield* repositoryWithWork

      const first = yield* checkedIn(mcp, { folder, baseRef: "main" })
      const changes = yield* client.GetCheckInChanges({ checkInId: first })

      yield* client.SaveCheckInNote({ checkInId: first, note: noteOn(changes.id, "Why 3?") })

      const second = yield* checkedIn(mcp, { folder, baseRef: "main" })

      const shown = checkIns(
        yield* inboxWhen(client, (items) => checkIns(items).some(({ id }) => id === second)),
      )

      assert.deepStrictEqual(
        shown.map(({ id }) => id),
        [second],
      )
      assert.deepStrictEqual(
        yield* readAnswer(mcp, first),
        CheckInReplaced.make({ checkInId: second }),
      )
      assert.deepStrictEqual(
        (yield* client.ListCheckInNotes({ checkInId: second })).map(({ text }) => text),
        ["Why 3?"],
      )
    }),
  )

  it.live("lists a Check-in until its answer is read, and never one the agent replaced", () =>
    Effect.gen(function* () {
      const { client, mcp } = yield* start
      const folder = yield* repositoryWithWork

      yield* checkedIn(mcp, { folder, baseRef: "main" })

      const second = yield* checkedIn(mcp, { folder, baseRef: "main" })

      assert.deepStrictEqual(yield* listAnswers(mcp), [[second, QuestionWaiting.make({})]])

      yield* shownCheckIn(client, second)
      yield* client.AnswerCheckIn({
        checkInId: second,
        answer: CheckInApprove.make({ message: "Ship it" }),
      })

      assert.deepStrictEqual(yield* listAnswers(mcp), [
        [second, CheckInApproved.make({ message: "Ship it", notes: [] })],
      ])
      assert.deepStrictEqual(yield* listAnswers(mcp), [])
    }),
  )

  it.live("refuses another agent's Check-in while one waits on the same folder", () =>
    Effect.gen(function* () {
      const backend = yield* start
      const folder = yield* repositoryWithWork

      yield* checkedIn(backend.mcp, { folder, baseRef: "main" })

      const otherAgent = yield* connectMcp(
        backend.baseUrl,
        yield* backend.outsideAgents.issue("pi"),
      )

      const refused = yield* otherAgent.call("check_in", { folder, baseRef: "main" })

      assert.isTrue(refused.isError)
      assert.include(toolText(refused), "Another agent's Check-in")
    }),
  )

  it.live("tells the agent a Check-in was set aside", () =>
    Effect.gen(function* () {
      const { client, mcp } = yield* start

      const checkInId = yield* checkedIn(mcp, {
        folder: yield* repositoryWithWork,
        baseRef: "main",
      })

      yield* shownCheckIn(client, checkInId)
      yield* client.SetCheckInAside({ checkInId })

      assert.deepStrictEqual(yield* readAnswer(mcp, checkInId), QuestionSetAside.make({}))
      yield* inboxWhen(client, (items) => checkIns(items).length === 0)

      const late = yield* client
        .AnswerCheckIn({ checkInId, answer: CheckInApprove.make({ message: null }) })
        .pipe(Effect.flip)

      assert.equal(late._tag, "CheckInNotWaiting")
    }),
  )

  it.live("keeps a waiting Check-in across a Glass restart", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const folder = yield* repositoryWithWork
      const before = yield* Scope.make()
      const first = yield* startBackend({}, home).pipe(Scope.provide(before))
      const bearer = yield* first.outsideAgents.issue("Claude Code")

      const checkInId = yield* checkedIn(yield* connectMcp(first.baseUrl, bearer), {
        folder,
        baseRef: "main",
      })

      yield* Scope.close(before, Exit.void)

      const second = yield* startBackend({}, home)

      yield* shownCheckIn(second.client, checkInId)
      yield* second.client.AnswerCheckIn({
        checkInId,
        answer: CheckInApprove.make({ message: "Ship it" }),
      })

      const answered = yield* readAnswer(yield* connectMcp(second.baseUrl, bearer), checkInId)

      assert.deepStrictEqual(answered, CheckInApproved.make({ message: "Ship it", notes: [] }))
    }),
  )

  it.live("keeps the notes for the folder's next Check-in when the agent is disconnected", () =>
    Effect.gen(function* () {
      const backend = yield* start
      const { client, mcp } = backend
      const folder = yield* repositoryWithWork

      const first = yield* checkedIn(mcp, { folder, baseRef: "main" })
      const changes = yield* client.GetCheckInChanges({ checkInId: first })

      yield* client.SaveCheckInNote({ checkInId: first, note: noteOn(changes.id, "Why 3?") })

      const [agent] = yield* client
        .WatchOutsideAgents()
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

      yield* client.RevokeOutsideAgent({ id: agent!.id })
      yield* inboxWhen(client, (items) => checkIns(items).length === 0)

      const again = yield* connectMcp(
        backend.baseUrl,
        yield* backend.outsideAgents.issue("Claude Code"),
      )

      const second = yield* checkedIn(again, { folder, baseRef: "main" })

      assert.deepStrictEqual(
        (yield* client.ListCheckInNotes({ checkInId: second })).map(({ text }) => text),
        ["Why 3?"],
      )
    }),
  )

  it.live("hands a Check-in's answer to no other agent", () =>
    Effect.gen(function* () {
      const backend = yield* start

      const checkInId = yield* checkedIn(backend.mcp, {
        folder: yield* repositoryWithWork,
        baseRef: "main",
      })

      const otherAgent = yield* connectMcp(
        backend.baseUrl,
        yield* backend.outsideAgents.issue("pi"),
      )

      const refused = yield* otherAgent.call("read_answer", { id: checkInId })

      assert.isTrue(refused.isError)
      assert.include(toolText(refused), "no Check-in with that id")
    }),
  )

  // Flaky: fetch to the MCP server failed with ECONNRESET in a full server run, passed on rerun
  it.live.skip("returns NoChanges without asking the user when nothing changed", () =>
    Effect.gen(function* () {
      const { mcp } = yield* start
      const folder = yield* repositoryWithWork

      gitIn(folder, "switch", "--quiet", "--discard-changes", "main")
      gitIn(folder, "clean", "--quiet", "--force")

      assert.deepStrictEqual(
        yield* checkIn(mcp, { folder, baseRef: "main" }),
        CheckInNoChanges.make({}),
      )
    }),
  )

  it.live("refuses a folder that holds no git repository", () =>
    Effect.gen(function* () {
      const { mcp } = yield* start
      const folder = yield* temporaryFolder

      const result = yield* mcp.call("check_in", { folder })

      assert.isTrue(result.isError)
      assert.include(toolText(result), "no git repository")
    }),
  )
})
