import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { PullRequestRef, Revision, Tour } from "@glass/contracts"
import { Effect, Equal, Exit, Option, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { useMemo } from "react"
import { Backend, backendRuntime } from "./backend"
import { describeStreamError, problemOf, unexpectedProblem } from "./problems"

type TourCommand = "write" | "cancel"

export const tourStates = Atom.family((pullRequest: PullRequestRef) =>
  backendRuntime.atom(
    Stream.unwrap(Backend.useSync((backend) => backend.WatchTour({ pullRequest }))),
  ),
)

export const isOutdated = (tour: Tour, revision: Revision) => !Equal.equals(tour.revision, revision)

export const useTour = (pullRequest: PullRequestRef, revision: Revision) => {
  const stateAtom = tourStates(pullRequest)

  const commandAtom = useMemo(
    () =>
      backendRuntime.fn((command: TourCommand) =>
        Backend.use((backend) =>
          command === "write"
            ? backend.WriteTour({ pullRequest, revision })
            : backend.CancelTour({ pullRequest }),
        ).pipe(
          Effect.exit,
          Effect.map((exit) => ({ command, exit })),
        ),
      ),
    [pullRequest, revision],
  )

  const state = useAtomValue(stateAtom)
  const [commandResult, runCommand] = useAtom(commandAtom)
  const reconnect = useAtomRefresh(stateAtom)

  const latest = Option.getOrNull(AsyncResult.value(state))
  const saved = latest?.tour ?? null
  const outdated = saved !== null && isOutdated(saved, revision) ? saved.revision : null
  const pending = commandResult.waiting
  const outcome = Option.getOrNull(AsyncResult.value(commandResult))

  const commandFailure =
    !pending && outcome !== null && Exit.isFailure(outcome.exit)
      ? { problem: problemOf(outcome.exit.cause), retry: () => runCommand(outcome.command) }
      : null

  const subscriptionProblem = AsyncResult.matchWithWaiting(state, {
    onWaiting: () => null,
    onSuccess: () => null,
    onDefect: () => unexpectedProblem,
    onError: describeStreamError,
  })

  return {
    latest,
    saved,
    writing: latest?.job.status === "writing",
    outdated,
    subscriptionProblem,
    commandFailure,
    pending,
    reconnect,
    write: () => runCommand("write"),
    cancel: () => runCommand("cancel"),
  }
}
