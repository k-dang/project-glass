import { assert, describe, it } from "@effect/vitest"
import {
  CheckInFeedback,
  CheckInNoChanges,
  CheckInResult,
  CheckInSendFeedback,
  FeedbackNote,
  type NeedsYou,
} from "@glass/contracts"
import { Effect, Fiber, Option, Predicate, Schema, Stream } from "effect"
import { writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitIn } from "../../test/gitRepositories"
import { startBackend } from "../../test/harness"
import { connectMcp, toolResult, toolText } from "../../test/mcpClient"

type Backend = Effect.Success<ReturnType<typeof startBackend>>

const checkIns = (items: NeedsYou) => items.filter((item) => Predicate.isTagged(item, "CheckIn"))

const checkInResult = Schema.decodeUnknownSync(CheckInResult)

const needsYou = (client: Backend["client"], until: (items: NeedsYou) => boolean) =>
  client.WatchNeedsYou().pipe(Stream.filter(until), Stream.runHead, Effect.map(Option.getOrThrow))

const waitingCheckIn = (client: Backend["client"]) =>
  needsYou(client, (items) => checkIns(items).length === 1).pipe(
    Effect.map((items) => checkIns(items)[0]!),
  )

const temporaryFolder = Effect.promise(() => mkdtemp(join(tmpdir(), "glass-check-in-")))

/** A repository on a branch off main, with one committed and one uncommitted change. */
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

const checkIn = (
  mcp: Effect.Success<ReturnType<typeof connectMcp>>,
  args: Readonly<Record<string, string>>,
) => mcp.request("tools/call", { name: "check_in", arguments: args }).response

const noteOn = (changesId: string, text: string) =>
  new FeedbackNote({
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
  it.live("shows the folder's changes in the Inbox and returns the feedback left on them", () =>
    Effect.gen(function* () {
      const { client, mcp } = yield* start
      const folder = yield* repositoryWithWork

      const inFlight = yield* Effect.forkChild(
        checkIn(mcp, { folder, baseRef: "main", summary: "Retry three times" }),
      )

      const waiting = yield* waitingCheckIn(client)

      assert.equal(waiting.summary, "Retry three times")
      assert.equal(waiting.askedBy, "Claude Code")

      const changes = yield* client.GetCheckInChanges({ checkInId: waiting.id })

      assert.deepStrictEqual(
        changes.files.map(({ path }) => path),
        ["backoff.ts", "retry.ts"],
      )

      yield* client.SaveCheckInNote({
        checkInId: waiting.id,
        note: noteOn(changes.id, "Read this from config"),
      })
      yield* client.AnswerCheckIn({
        checkInId: waiting.id,
        answer: CheckInSendFeedback.make({ message: "Close, one thing" }),
      })

      assert.deepStrictEqual(
        checkInResult(toolResult(yield* Fiber.join(inFlight)).structuredContent),
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
      assert.equal(checkIns(yield* needsYou(client, () => true)).length, 0)
    }),
  )

  it.live(
    "keeps the notes for the folder's next Check-in when the agent goes before an answer",
    () =>
      Effect.gen(function* () {
        const backend = yield* start
        const { client, mcp } = backend
        const folder = yield* repositoryWithWork

        yield* Effect.forkChild(checkIn(mcp, { folder, baseRef: "main" }))

        const first = yield* waitingCheckIn(client)
        const changes = yield* client.GetCheckInChanges({ checkInId: first.id })

        yield* client.SaveCheckInNote({ checkInId: first.id, note: noteOn(changes.id, "Why 3?") })

        const [agent] = yield* client
          .WatchOutsideAgents()
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

        yield* client.RevokeOutsideAgent({ id: agent!.id })
        yield* needsYou(client, (items) => checkIns(items).length === 0)

        const again = yield* connectMcp(
          backend.baseUrl,
          yield* backend.outsideAgents.issue("Claude Code"),
        )

        yield* Effect.forkChild(checkIn(again, { folder, baseRef: "main" }))

        const second = yield* waitingCheckIn(client)

        assert.deepStrictEqual(
          (yield* client.ListCheckInNotes({ checkInId: second.id })).map(({ text }) => text),
          ["Why 3?"],
        )
      }),
  )

  it.live("refuses a second Check-in on a folder that already has one waiting", () =>
    Effect.gen(function* () {
      const backend = yield* start
      const folder = yield* repositoryWithWork

      yield* Effect.forkChild(checkIn(backend.mcp, { folder, baseRef: "main" }))
      yield* waitingCheckIn(backend.client)

      const otherAgent = yield* connectMcp(
        backend.baseUrl,
        yield* backend.outsideAgents.issue("pi"),
      )

      const result = toolResult(yield* checkIn(otherAgent, { folder, baseRef: "main" }))

      assert.isTrue(result.isError)
      assert.include(toolText(result), "already waiting")
    }),
  )

  it.live("returns NoChanges without asking the user when nothing changed", () =>
    Effect.gen(function* () {
      const { mcp } = yield* start
      const folder = yield* repositoryWithWork

      gitIn(folder, "switch", "--quiet", "--discard-changes", "main")
      gitIn(folder, "clean", "--quiet", "--force")

      const result = toolResult(yield* checkIn(mcp, { folder, baseRef: "main" }))

      assert.deepStrictEqual(checkInResult(result.structuredContent), CheckInNoChanges.make({}))
    }),
  )

  it.live("refuses a folder that holds no git repository", () =>
    Effect.gen(function* () {
      const { mcp } = yield* start
      const folder = yield* temporaryFolder

      const result = toolResult(yield* checkIn(mcp, { folder }))

      assert.isTrue(result.isError)
      assert.include(toolText(result), "no git repository")
    }),
  )
})
