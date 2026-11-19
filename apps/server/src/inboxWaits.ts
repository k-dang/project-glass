import { Deferred, type Duration, Effect, Option, Schema, Stream, SubscriptionRef } from "effect"

export class AlreadyWaiting extends Schema.TaggedError<AlreadyWaiting>()("AlreadyWaiting", {
  on: Schema.Literals(["session", "subject"]),
}) {}

interface Waiting<Item, Result> {
  readonly item: Item
  readonly session: string
  readonly slot: Deferred.Deferred<Result>
  readonly settled: Deferred.Deferred<void>
}

/**
 * What Outside agents wait on in the Inbox, one per MCP session and one per subject, until the
 * user answers, the wait ends, the caller goes, or Glass shuts down.
 */
export const inboxWaitsOf = <Item, Result>(options: {
  readonly idOf: (item: Item) => string
  /** What only one wait may be on at a time, such as a Check-in's folder. */
  readonly subjectOf?: (item: Item) => string
  readonly timedOut: Result
  readonly cancelled: Result
}) =>
  Effect.gen(function* () {
    const pending = yield* SubscriptionRef.make<ReadonlyArray<Waiting<Item, Result>>>([])

    const publish = (slot: Deferred.Deferred<Result>, result: Result) =>
      Deferred.succeed(slot, result).pipe(Effect.ignore)

    /** Ends the wait on `id` with `result`, telling whether it was still waiting. */
    const resolve = (id: string, result: Result) =>
      SubscriptionRef.modify(pending, (items) => {
        const found = items.find(({ item }) => options.idOf(item) === id)

        return found === undefined
          ? ([undefined, items] as const)
          : ([found.slot, items.filter((item) => item !== found)] as const)
      }).pipe(
        Effect.flatMap((slot) =>
          slot === undefined ? Effect.succeed(false) : publish(slot, result).pipe(Effect.as(true)),
        ),
      )

    const sameSubject = (a: Item, b: Item) =>
      options.subjectOf !== undefined && options.subjectOf(a) === options.subjectOf(b)

    const wait = (item: Item, session: string, timeout: Duration.Duration) =>
      Effect.scoped(
        Effect.gen(function* () {
          const slot = yield* Deferred.make<Result>()
          const settled = yield* Deferred.make<void>()
          const id = options.idOf(item)

          const refused = yield* SubscriptionRef.modify(pending, (items) => {
            if (items.some((waiting) => waiting.session === session))
              return ["session" as const, items] as const

            if (items.some((waiting) => sameSubject(waiting.item, item)))
              return ["subject" as const, items] as const

            return [null, [...items, { item, session, slot, settled }]] as const
          })

          if (refused !== null) return yield* new AlreadyWaiting({ on: refused })

          yield* Effect.sleep(timeout).pipe(
            Effect.andThen(resolve(id, options.timedOut)),
            Effect.forkScoped,
          )

          return yield* Deferred.await(slot).pipe(
            Effect.onInterrupt(() => resolve(id, options.cancelled)),
            Effect.ensuring(Deferred.succeed(settled, undefined).pipe(Effect.ignore)),
          )
        }),
      )

    const find = (id: string) =>
      SubscriptionRef.get(pending).pipe(
        Effect.map((items) =>
          Option.fromNullishOr(items.find(({ item }) => options.idOf(item) === id)?.item),
        ),
      )

    // Waits for every caller to see Cancelled, so shutting down doesn't leave a response open.
    const cancelAll = Effect.fnUntraced(function* () {
      const items = yield* SubscriptionRef.modify(pending, (current) => [current, []] as const)

      yield* Effect.forEach(items, ({ slot }) => publish(slot, options.cancelled), {
        discard: true,
        concurrency: "unbounded",
      })
      yield* Effect.forEach(items, ({ settled }) => Deferred.await(settled), {
        discard: true,
        concurrency: "unbounded",
      })
    })

    return {
      wait,
      resolve,
      find,
      watch: () =>
        SubscriptionRef.changes(pending).pipe(Stream.map((items) => items.map(({ item }) => item))),
      cancelAll,
    }
  })
