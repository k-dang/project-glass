import { assert, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Redacted, Schema, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { eventually } from "../../test/eventually"
import { wrappedFileSystem } from "../../test/wrappedFileSystem"
import { forgottenByGlass, RECORD_CHECK_INTERVAL } from "./forgotten"
import { RecordedHost } from "./hostAddress"

const TOKEN = "this-host"

const recordNaming = (token: string) =>
  Schema.encodeSync(RecordedHost)({ port: 5123, token, fingerprint: "build" })

const advanceUntil = (assertion: () => void) =>
  eventually(TestClock.adjust(RECORD_CHECK_INTERVAL).pipe(Effect.andThen(Effect.sync(assertion))))

const watching = Effect.gen(function* () {
  let reads = 0

  const fileSystem = wrappedFileSystem((fs) => ({
    readFileString: (path, encoding) =>
      fs.readFileString(path, encoding).pipe(Effect.ensuring(Effect.sync(() => reads++))),
  }))

  const fs = yield* FileSystem.FileSystem.pipe(Effect.provide(fileSystem))
  const record = join(yield* fs.makeTempDirectoryScoped(), "agent-host.json")
  writeFileSync(record, recordNaming(TOKEN))
  const attendance = yield* SubscriptionRef.make({ followers: 0, unacknowledged: 0 })

  const fiber = yield* forgottenByGlass(record, Redacted.make(TOKEN), attendance).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.forkChild,
  )

  return {
    write: (contents: string) => Effect.sync(() => writeFileSync(record, contents)),
    remove: Effect.sync(() => rmSync(record)),
    followers: (followers: number) =>
      SubscriptionRef.update(attendance, (before) => ({ ...before, followers })),
    keptRunningTwoChecks: Effect.gen(function* () {
      const before = reads
      yield* advanceUntil(() => assert.isAtLeast(reads, before + 2))
    }),
    stopped: advanceUntil(() => assert.isDefined(fiber.pollUnsafe())).pipe(
      Effect.andThen(Fiber.join(fiber)),
    ),
  }
})

it.effect("keeps running while Glass's record names it", () =>
  Effect.gen(function* () {
    const host = yield* watching

    yield* host.keptRunningTwoChecks
  }).pipe(Effect.scoped),
)

it.effect("keeps running while Glass's record can't be read", () =>
  Effect.gen(function* () {
    const host = yield* watching

    yield* host.write("{ half a record")
    yield* host.keptRunningTwoChecks
  }).pipe(Effect.scoped),
)

it.effect("stops once Glass's record names another host and no backend follows it", () =>
  Effect.gen(function* () {
    const host = yield* watching

    yield* host.write(recordNaming("a newer host"))
    yield* host.stopped
  }).pipe(Effect.scoped),
)

it.effect("stops once Glass's record is gone and no backend follows it", () =>
  Effect.gen(function* () {
    const host = yield* watching

    yield* host.remove
    yield* host.stopped
  }).pipe(Effect.scoped),
)

it.effect("keeps running without a record while a backend follows it", () =>
  Effect.gen(function* () {
    const host = yield* watching

    yield* host.followers(1)
    yield* host.remove
    yield* host.keptRunningTwoChecks

    yield* host.followers(0)
    yield* host.stopped
  }).pipe(Effect.scoped),
)
