import { Effect } from "effect"
import { writeFileSync } from "node:fs"
import { startFakeAnthropic } from "../../../../apps/server/test/fakeAnthropic.ts"

export const serveFakeAnthropic = (readyFile: string) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const provider = yield* startFakeAnthropic
    writeFileSync(readyFile, JSON.stringify({ port: Number(new URL(provider.url).port) }))
    yield* Effect.never
  })))
