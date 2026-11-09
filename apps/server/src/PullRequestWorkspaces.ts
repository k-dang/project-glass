import {
  type ConnectionError,
  type PullRequestAccessDenied,
  type PullRequestNotFound,
  type PullRequestRef,
  type PullRequestWorkspace,
  referenceKey,
} from "@glass/contracts"
import { Context, Effect, Exit, Fiber, Layer, Scope, Semaphore } from "effect"
import { GitHubClient } from "./github/GitHubClient"
import { BackgroundGitHubRequest } from "./github/GitHubRequestPolicy"
import { annotateUnit } from "./wideEvents"

const PREFETCH_SLOTS = 2

type ReadError = PullRequestNotFound | PullRequestAccessDenied | ConnectionError

interface Prefetch {
  readonly fiber: Fiber.Fiber<PullRequestWorkspace, ReadError>
  readonly reading: { holdsSlot: boolean }
}

export class PullRequestWorkspaces extends Context.Service<
  PullRequestWorkspaces,
  {
    readonly prefetch: (refs: ReadonlyArray<PullRequestRef>) => Effect.Effect<void>
    readonly forget: (ref: PullRequestRef) => Effect.Effect<void>
    readonly open: (ref: PullRequestRef) => Effect.Effect<PullRequestWorkspace, ReadError>
  }
>()("@glass/server/PullRequestWorkspaces") {
  static readonly layer = Layer.effect(
    PullRequestWorkspaces,
    Effect.gen(function* () {
      const github = yield* GitHubClient
      const scope = yield* Scope.Scope
      const slots = yield* Semaphore.make(PREFETCH_SLOTS)
      const prefetches = new Map<string, Prefetch>()

      const take = (ref: PullRequestRef) =>
        Effect.sync(() => {
          const key = referenceKey(ref)
          const taken = prefetches.get(key)
          prefetches.delete(key)

          return taken
        })

      const prefetchOne = Effect.fnUntraced(function* (ref: PullRequestRef) {
        const key = referenceKey(ref)

        if (prefetches.has(key)) return

        const reading = { holdsSlot: false }

        const fiber = yield* Effect.sync(() => {
          reading.holdsSlot = true
        }).pipe(
          Effect.andThen(github.pullRequest(ref)),
          slots.withPermits(1),
          Effect.provideService(BackgroundGitHubRequest, true),
          Effect.tapError((error) => Effect.logWarning("Couldn't prefetch a queued PR", error)),
          Effect.withSpan("PullRequestWorkspaces.prefetch", {
            root: true,
            attributes: { pr: key },
          }),
          Effect.forkIn(scope),
        )

        prefetches.set(key, { fiber, reading })
      })

      const prefetch = (refs: ReadonlyArray<PullRequestRef>) =>
        Effect.forEach(refs, prefetchOne, { discard: true })

      const forget = (ref: PullRequestRef) =>
        take(ref).pipe(
          Effect.flatMap((taken) =>
            taken === undefined ? Effect.void : Fiber.interrupt(taken.fiber),
          ),
        )

      const usable = Effect.fnUntraced(function* ({ fiber, reading }: Prefetch) {
        if (!reading.holdsSlot) {
          yield* Fiber.interrupt(fiber)

          return null
        }

        const exit = yield* Effect.exit(Fiber.join(fiber))

        if (Exit.isFailure(exit)) return null

        const { pullRequest, revision, updatedAt } = exit.value

        return (yield* github.hasChanged(pullRequest.id, revision, updatedAt)) ? null : exit.value
      })

      const open = Effect.fn("PullRequestWorkspaces.open")(function* (ref: PullRequestRef) {
        const taken = yield* take(ref)
        const ready = taken === undefined ? null : yield* usable(taken)

        yield* annotateUnit({ prefetched: ready !== null })

        return ready ?? (yield* github.pullRequest(ref))
      })

      return PullRequestWorkspaces.of({ prefetch, forget, open })
    }),
  )
}
