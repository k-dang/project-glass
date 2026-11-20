import { Effect, FileSystem, Predicate, Redacted, SubscriptionRef } from "effect"
import { readHostRecord } from "./hostAddress"
import type { Journal } from "./Journal"

export const RECORD_CHECK_INTERVAL = "1 minute"

export const forgottenByGlass = (
  record: string,
  token: Redacted.Redacted,
  attendance: Journal["Service"]["attendance"],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const recordNamesThisHost = readHostRecord(fs, record).pipe(
      Effect.map((recorded) => recorded.token === Redacted.value(token)),
      Effect.catchTag("PlatformError", (error) =>
        Effect.succeed(!Predicate.isTagged(error.reason, "NotFound")),
      ),
      Effect.orElseSucceed(() => true),
    )

    const forgotten = Effect.gen(function* () {
      if (yield* recordNamesThisHost) return false

      return (yield* SubscriptionRef.get(attendance)).followers === 0
    })

    yield* forgotten.pipe(
      Effect.delay(RECORD_CHECK_INTERVAL),
      Effect.repeat({ until: (gone) => gone }),
    )

    yield* Effect.logWarning("Glass no longer records this agent host, so it stops")
  })
