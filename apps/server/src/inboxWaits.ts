import { Deferred, type Duration, Effect, Stream, SubscriptionRef } from "effect"

interface Waiting<Item, Result> {
  readonly item: Item
  readonly slot: Deferred.Deferred<Result>
  readonly settled: Deferred.Deferred<void>
}

export const inboxWaitsOf = <Item, Result>(options: {
  readonly idOf: (item: Item) => string
  readonly timedOut: Result
  readonly cancelled: Result
}) =>
  Effect.gen(function* () {
    const pending = yield* SubscriptionRef.make<ReadonlyArray<Waiting<Item, Result>>>([])

    const publish = (slot: Deferred.Deferred<Result>, result: Result) =>
      Deferred.succeed(slot, result).pipe(Effect.ignore)

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

    const wait = (item: Item, timeout: Duration.Duration) =>
      Effect.scoped(
        Effect.gen(function* () {
          const slot = yield* Deferred.make<Result>()
          const settled = yield* Deferred.make<void>()
          const id = options.idOf(item)

          yield* SubscriptionRef.update(pending, (items) => [...items, { item, slot, settled }])

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
      watch: () =>
        SubscriptionRef.changes(pending).pipe(Stream.map((items) => items.map(({ item }) => item))),
      cancelAll,
    }
  })
