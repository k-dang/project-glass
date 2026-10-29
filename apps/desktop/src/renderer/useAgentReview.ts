import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { PullRequestRef, Revision } from "@glass/contracts"
import { Effect, Equal, Exit, Option, Predicate, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { useCallback, useMemo } from "react"
import { Backend, backendRuntime } from "./backend"
import { describeError, problemOf, unexpectedProblem } from "./problems"

type AgentReviewCommand = "start" | "cancel"

const agentReviewStates = Atom.family((pullRequest: PullRequestRef) =>
  backendRuntime.atom(
    Stream.unwrap(Backend.useSync((backend) => backend.WatchAgentReview({ pullRequest }))),
  ),
)

export const useAgentReview = (
  pullRequest: PullRequestRef,
  revision: Revision,
  startable: boolean,
) => {
  const stateAtom = agentReviewStates(pullRequest)

  const commandAtom = useMemo(
    () =>
      backendRuntime.fn((command: AgentReviewCommand) =>
        Backend.use((backend) =>
          command === "start"
            ? backend.StartAgentReview({ pullRequest, revision })
            : backend.CancelAgentReview({ pullRequest }),
        ).pipe(
          Effect.exit,
          Effect.map((exit) => ({ command, exit })),
        ),
      ),
    [pullRequest, revision],
  )

  const state = useAtomValue(stateAtom)
  const reconnect = useAtomRefresh(stateAtom)
  const [commandResult, runCommand] = useAtom(commandAtom)
  const latest = Option.getOrNull(AsyncResult.value(state))
  const outcome = Option.getOrNull(AsyncResult.value(commandResult))

  const commandProblem =
    !commandResult.waiting && outcome !== null && Exit.isFailure(outcome.exit)
      ? problemOf(outcome.exit.cause)
      : null

  const subscriptionProblem = AsyncResult.matchWithWaiting(state, {
    onWaiting: () => null,
    onSuccess: () => null,
    onDefect: () => unexpectedProblem,
    onError: (error) =>
      Predicate.isTagged(error, "NoSuchElementError") ? unexpectedProblem : describeError(error),
  })

  const start = useCallback(() => runCommand("start"), [runCommand])
  const cancel = useCallback(() => runCommand("cancel"), [runCommand])

  const review = latest?.review ?? null
  const current = review !== null && Equal.equals(review.revision, revision)

  return {
    job: latest?.job ?? null,
    review,
    outdated: review !== null && !current,
    commandProblem,
    subscriptionProblem,
    reconnect,
    /** Null where no Agent review can start, such as a closed PR. */
    start: startable ? start : null,
    cancel,
  }
}

export type AgentReviewControls = ReturnType<typeof useAgentReview>
