import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { AgentReview, AgentReviewState, PullRequestRef, Revision } from "@glass/contracts"
import { Equal, Option, Predicate, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { useCallback, useMemo } from "react"
import { Backend, backendRuntime } from "./backend"
import { describeError, settledProblem, unexpectedProblem } from "./problems"

type AgentReviewCommand = "start" | "cancel"

const keepReview = (previous: AgentReview | null, state: AgentReviewState) => {
  const review = Equal.equals(previous, state.review) ? previous : state.review

  return [review, [{ ...state, review }]] as const
}

export const agentReviewStates = Atom.family((pullRequest: PullRequestRef) =>
  backendRuntime.atom(
    Stream.unwrap(Backend.useSync((backend) => backend.WatchAgentReview({ pullRequest }))).pipe(
      Stream.mapAccum((): AgentReview | null => null, keepReview),
    ),
  ),
)

export const useAgentReview = (
  pullRequest: PullRequestRef,
  revision: Revision,
  closedAs: "closed" | "merged" | null,
) => {
  const stateAtom = agentReviewStates(pullRequest)

  const commandAtom = useMemo(
    () =>
      backendRuntime.fn((command: AgentReviewCommand) =>
        Backend.use((backend) =>
          command === "start"
            ? backend.StartAgentReview({ pullRequest, revision })
            : backend.CancelAgentReview({ pullRequest }),
        ),
      ),
    [pullRequest, revision],
  )

  const state = useAtomValue(stateAtom)
  const reconnect = useAtomRefresh(stateAtom)
  const [commandResult, runCommand] = useAtom(commandAtom)
  const latest = Option.getOrNull(AsyncResult.value(state))

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
  const current = review !== null && Equal.equals(review.revision, revision) ? review : null

  return {
    known: AsyncResult.isNotInitial(state),
    job: latest?.job ?? null,
    review,
    current,
    outdated: review !== null && current === null,
    commandProblem: settledProblem(commandResult),
    subscriptionProblem,
    reconnect,
    closedAs,
    start: closedAs === null ? start : null,
    cancel,
  }
}

export type AgentReviewControls = ReturnType<typeof useAgentReview>
