import { assert, it } from "@effect/vitest"
import { PartSet, TextPart } from "@glass/contracts"
import { Effect, Stream } from "effect"
import { Journal } from "./Journal"
import { HostReplaced } from "./protocol"

it.effect("refuses to replay another host's cursor, and ignores its acknowledgements", () =>
  Effect.gen(function* () {
    const journal = yield* Journal
    yield* journal.append(
      "agent",
      PartSet.make({ turnId: "turn", index: 0, part: TextPart.make({ text: "hi" }) }),
    )
    yield* journal.acknowledge("another host", 1)

    const refused = yield* journal.watch("another host", 0).pipe(Stream.runCollect, Effect.flip)
    assert.instanceOf(refused, HostReplaced)

    const [kept] = yield* journal.watch(journal.host, 0).pipe(Stream.take(1), Stream.runCollect)
    assert.equal(kept?.sequence, 1)
  }).pipe(Effect.provide(Journal.layer)),
)
