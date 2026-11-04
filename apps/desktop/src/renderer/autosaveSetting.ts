import { Effect, Equal, Exit, Option, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { type Backend, type BackendError, backendRuntime } from "./backend"

export function autosaveSetting<A>(
  read: Effect.Effect<A, BackendError, Backend>,
  write: (value: A) => Effect.Effect<A, BackendError, Backend>,
  normalize: (value: A) => A,
) {
  const load = backendRuntime.atom(read).pipe(Atom.keepAlive)
  const draft = Atom.make<A | null>(null).pipe(Atom.keepAlive)
  const pending = Atom.make<A | null>(null).pipe(Atom.keepAlive)

  const save = backendRuntime
    .fn((_: void, get) =>
      Stream.unfold(undefined, () =>
        Effect.gen(function* () {
          while (true) {
            const next = get(pending)

            if (next === null) return undefined

            get.set(pending, null)
            const result = yield* Effect.exit(write(next))

            if (Exit.isFailure(result)) {
              if (get(pending) !== null) continue

              return yield* Effect.failCause(result.cause)
            }

            if (Equal.equals(get(draft), next)) get.set(draft, null)

            return [result.value, undefined] as const
          }
        }),
      ),
    )
    .pipe(Atom.keepAlive)

  const saved = Atom.make((get) =>
    Option.match(AsyncResult.value(get(save)), {
      onSome: (value) => AsyncResult.success(value),
      onNone: () => get(load),
    }),
  )

  const commit = Atom.writable(
    () => undefined,
    (ctx, value: A) => {
      const next = normalize(value)
      const waiting = ctx.get(save).waiting
      ctx.set(draft, next)

      if (!waiting) {
        const current = AsyncResult.value(ctx.get(saved))

        if (Option.exists(current, (stored) => Equal.equals(stored, next))) {
          ctx.set(draft, null)

          return
        }
      }

      ctx.set(pending, next)

      if (!waiting) ctx.set(save, undefined)
    },
  )

  return { load, draft, save, saved, commit, normalize }
}
