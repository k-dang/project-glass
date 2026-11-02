import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { PullRequestRef, Revision } from "@glass/contracts"
import { Effect, Equal, Exit, Match, Option, Predicate, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { useCallback, useMemo } from "react"
import { Backend, backendRuntime } from "./backend"
import { describeError, problemOf, unexpectedProblem } from "./problems"

type AgentReviewCommand =
  | { readonly kind: "start" }
  | { readonly kind: "cancel" }
  | { readonly kind: "follow-up"; readonly message: string }

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
          Match.value(command).pipe(
            Match.discriminatorsExhaustive("kind")({
              start: () => backend.StartAgentReview({ pullRequest, revision }),
              cancel: () => backend.CancelAgentReview({ pullRequest }),
              "follow-up": ({ message }) =>
                backend.FollowUpAgentReview({ pullRequest, revision, message }),
            }),
          ),
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

  const problem =
    !commandResult.waiting && outcome !== null && Exit.isFailure(outcome.exit)
      ? problemOf(outcome.exit.cause)
      : null

  const followingUp = outcome?.command.kind === "follow-up"

  const subscriptionProblem = AsyncResult.matchWithWaiting(state, {
    onWaiting: () => null,
    onSuccess: () => null,
    onDefect: () => unexpectedProblem,
    onError: (error) =>
      Predicate.isTagged(error, "NoSuchElementError") ? unexpectedProblem : describeError(error),
  })

  const start = useCallback(() => runCommand({ kind: "start" }), [runCommand])
  const cancel = useCallback(() => runCommand({ kind: "cancel" }), [runCommand])

  const followUp = useCallback(
    (message: string) => runCommand({ kind: "follow-up", message }),
    [runCommand],
  )

  const review = latest?.review ?? null
  const current = review !== null && Equal.equals(review.revision, revision)

  return {
    job: latest?.job ?? null,
    review,
    outdated: review !== null && !current,
    /** Why starting or cancelling the Agent review failed. */
    commandProblem: followingUp ? null : problem,
    /** Why the backend refused a follow-up before the agent ran. */
    followUpProblem: followingUp ? problem : null,
    subscriptionProblem,
    reconnect,
    /** Null where no Agent review can start, such as a closed PR. */
    start: startable ? start : null,
    followUp,
    cancel,
  }
}

export type AgentReviewControls = ReturnType<typeof useAgentReview>
