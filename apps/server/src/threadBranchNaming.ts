import { Deferred, Effect, Option, Scope, Semaphore } from "effect"
import { BranchNames } from "./BranchNames"

export const threadBranchNaming = Effect.fnUntraced(function* <E>(
  claim: (threadId: string, suggested: string) => Effect.Effect<void, E>,
) {
  const branchNames = yield* BranchNames
  const scope = yield* Scope.Scope
  const claiming = yield* Semaphore.make(1)
  const gates = new Map<string, Deferred.Deferred<void>>()

  const release = (threadId: string) =>
    Effect.suspend(() => {
      const gate = gates.get(threadId)
      gates.delete(threadId)

      return gate === undefined ? Effect.void : Deferred.succeed(gate, undefined)
    })

  return {
    hold: (threadId: string) =>
      Deferred.make<void>().pipe(
        Effect.map((gate) => {
          gates.set(threadId, gate)
        }),
      ),
    release,
    name: (threadId: string, request: string) =>
      branchNames.suggest(request).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (suggested) => claiming.withPermits(1)(claim(threadId, suggested)),
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Kept a Thread's placeholder branch", cause),
        ),
        Effect.ensuring(release(threadId)),
        Effect.forkIn(scope),
        Effect.asVoid,
      ),
    named: (threadId: string) =>
      Effect.suspend(() => {
        const gate = gates.get(threadId)

        return gate === undefined ? Effect.void : Deferred.await(gate)
      }),
  }
})
