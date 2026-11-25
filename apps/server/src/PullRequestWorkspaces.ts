import {
  type ConnectionError,
  type PullRequestAccessDenied,
  type PullRequestNotFound,
  type PullRequestRef,
  type PullRequestWorkspace,
  referenceKey,
} from "@glass/contracts"
import { Context, DateTime, Effect, Exit, Fiber, Layer, Scope, Semaphore, Stream } from "effect"
import { GitHubClient } from "./github/GitHubClient"
import { BackgroundGitHubRequest } from "./github/GitHubRequestPolicy"
import { PullRequestLists } from "./PullRequestLists"
import { Queue } from "./Queue"
import { annotateUnit } from "./wideEvents"

const PREFETCH_SLOTS = 2

type ReadError = PullRequestNotFound | PullRequestAccessDenied | ConnectionError

interface HeldPullRequest {
  readonly ref: PullRequestRef
  readonly updatedAt: DateTime.Utc
}

interface Prefetch {
  readonly updatedAt: DateTime.Utc
  readonly fiber: Fiber.Fiber<PullRequestWorkspace, ReadError>
  readonly reading: { holdsSlot: boolean }
}

export class PullRequestWorkspaces extends Context.Service<
  PullRequestWorkspaces,
  {
    readonly open: (ref: PullRequestRef) => Effect.Effect<PullRequestWorkspace, ReadError>
  }
>()("@glass/server/PullRequestWorkspaces") {
  static readonly layer = Layer.effect(
    PullRequestWorkspaces,
    Effect.gen(function* () {
      const github = yield* GitHubClient
      const lists = yield* PullRequestLists
      const queue = yield* Queue
      const scope = yield* Scope.Scope
      const slots = yield* Semaphore.make(PREFETCH_SLOTS)
      const prefetches = new Map<string, Prefetch>()
      // WARNING: GitHub doesn't move updatedAt for some of Glass's own writes, such as viewed files, so a workspace is served from here at most once.
      const opened = new Set<string>()

      const take = (key: string) => {
        const taken = prefetches.get(key)
        prefetches.delete(key)

        return taken
      }

      const drop = (key: string) =>
        Effect.suspend(() => {
          const dropped = take(key)

          return dropped === undefined ? Effect.void : Fiber.interrupt(dropped.fiber)
        })

      const prefetchOne = Effect.fnUntraced(function* ({ ref, updatedAt }: HeldPullRequest) {
        const key = referenceKey(ref)

        if (opened.has(key)) return

        const current = prefetches.get(key)

        if (current !== undefined && DateTime.isGreaterThanOrEqualTo(current.updatedAt, updatedAt))
          return

        yield* drop(key)

        const reading = { holdsSlot: false }

        const fiber = yield* Effect.sync(() => {
          reading.holdsSlot = true
        }).pipe(
          Effect.andThen(github.pullRequest(ref)),
          slots.withPermits(1),
          Effect.provideService(BackgroundGitHubRequest, true),
          Effect.tapError((error) => Effect.logWarning("Couldn't prefetch a PR", error)),
          Effect.withSpan("PullRequestWorkspaces.prefetch", {
            root: true,
            attributes: { pr: key },
          }),
          Effect.forkIn(scope),
        )

        if (opened.has(key)) yield* Fiber.interrupt(fiber)
        else prefetches.set(key, { updatedAt, fiber, reading })
      })

      const keep = Effect.fnUntraced(function* (pullRequests: ReadonlyArray<HeldPullRequest>) {
        const held = new Set(pullRequests.map(({ ref }) => referenceKey(ref)))

        yield* Effect.forEach(
          [...prefetches.keys()].filter((key) => !held.has(key)),
          drop,
          { discard: true, concurrency: "unbounded" },
        )

        yield* Effect.forEach(pullRequests, prefetchOne, { discard: true })
      })

      const readyInQueue = queue.watch().pipe(
        Stream.map((pullRequests) =>
          pullRequests.flatMap(({ pullRequest, problem }) =>
            problem === null ? [pullRequest] : [],
          ),
        ),
        Stream.catch(() => Stream.make([])),
      )

      yield* Stream.zipLatestAll(lists.shown, readyInQueue).pipe(
        Stream.runForEach(([listed, queued]) => keep([...listed, ...queued])),
        Effect.forkScoped,
      )

      const usable = Effect.fnUntraced(function* ({ fiber, reading }: Prefetch) {
        if (!reading.holdsSlot) {
          yield* Fiber.interrupt(fiber)

          return null
        }

        const exit = yield* Effect.exit(Fiber.join(fiber))

        return Exit.isSuccess(exit) ? exit.value : null
      })

      const open = Effect.fn("PullRequestWorkspaces.open")(function* (ref: PullRequestRef) {
        const key = referenceKey(ref)
        const taken = take(key)

        opened.add(key)

        const ready = taken === undefined ? null : yield* usable(taken)

        yield* annotateUnit({ prefetched: ready !== null })

        return ready ?? (yield* github.pullRequest(ref))
      })

      return PullRequestWorkspaces.of({ open })
    }),
  )
}
