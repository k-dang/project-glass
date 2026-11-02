import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { PullRequestRef, Revision } from "@glass/contracts"
import { Effect, Equal, Exit, Option, Predicate, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { useCallback, useMemo } from "react"
import { Backend, type BackendError, backendRuntime } from "./backend"
import { describeError, problemOf, unexpectedProblem } from "./problems"

type AgentReviewCommand = "start" | "cancel"

const agentReviewStates = Atom.family((pullRequest: PullRequestRef) =>
  backendRuntime.atom(
    Stream.unwrap(Backend.useSync((backend) => backend.WatchAgentReview({ pullRequest }))),
  ),
)

/** Why a command's latest call failed, once it has settled. */
const problemOfResult = (result: AsyncResult.AsyncResult<Exit.Exit<void, BackendError>>) => {
  const exit = Option.getOrNull(AsyncResult.value(result))

  return !result.waiting && exit !== null && Exit.isFailure(exit) ? problemOf(exit.cause) : null
}

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
        ).pipe(Effect.exit),
      ),
    [pullRequest, revision],
  )

  const followUpAtom = useMemo(
    () =>
      backendRuntime.fn((message: string) =>
        Backend.use((backend) =>
          backend.FollowUpAgentReview({ pullRequest, revision, message }),
        ).pipe(Effect.exit),
      ),
    [pullRequest, revision],
  )

  const state = useAtomValue(stateAtom)
  const reconnect = useAtomRefresh(stateAtom)
  const [commandResult, runCommand] = useAtom(commandAtom)
  const [followUpResult, runFollowUp] = useAtom(followUpAtom)
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
  const followUp = useCallback((message: string) => runFollowUp(message), [runFollowUp])

  const review = latest?.review ?? null
  const current = review !== null && Equal.equals(review.revision, revision)

  return {
    job: latest?.job ?? null,
    review,
    outdated: review !== null && !current,
    /** Why starting or cancelling the Agent review failed. */
    commandProblem: problemOfResult(commandResult),
    /** Why the backend refused a Follow-up before the agent ran. */
    followUpProblem: problemOfResult(followUpResult),
    subscriptionProblem,
    reconnect,
    /** Null where no Agent review can start, such as a closed PR. */
    start: startable ? start : null,
    followUp,
    cancel,
  }
}

export type AgentReviewControls = ReturnType<typeof useAgentReview>
