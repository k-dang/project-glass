import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import type { PullRequestRef, Revision } from "@glass/contracts"
import { Equal, Exit, Option, Predicate, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { useCallback, useMemo, useRef } from "react"
import { Backend, backendRuntime } from "./backend"
import { describeError, settledProblem, unexpectedProblem } from "./problems"

type AgentReviewCommand = "start" | "cancel"

export const agentReviewStates = Atom.family((pullRequest: PullRequestRef) =>
  backendRuntime.atom(
    Stream.unwrap(Backend.useSync((backend) => backend.WatchAgentReview({ pullRequest }))),
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

  const followUpAtom = useMemo(
    () =>
      backendRuntime.fn((message: string) =>
        Backend.use((backend) => backend.FollowUpAgentReview({ pullRequest, revision, message })),
      ),
    [pullRequest, revision],
  )

  const state = useAtomValue(stateAtom)
  const reconnect = useAtomRefresh(stateAtom)
  const [commandResult, runCommand] = useAtom(commandAtom)
  const followUpResult = useAtomValue(followUpAtom)
  const runFollowUp = useAtomSet(followUpAtom, { mode: "promiseExit" })
  const sendingFollowUp = useRef(false)
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

  const followUp = async (message: string) => {
    if (sendingFollowUp.current) return false

    sendingFollowUp.current = true

    try {
      return Exit.isSuccess(await runFollowUp(message))
    } finally {
      sendingFollowUp.current = false
    }
  }

  const review = latest?.review ?? null
  const current = review !== null && Equal.equals(review.revision, revision)

  return {
    job: latest?.job ?? null,
    review,
    outdated: review !== null && !current,
    commandProblem: settledProblem(commandResult),
    followUpProblem: settledProblem(followUpResult),
    followUpPending: followUpResult.waiting,
    subscriptionProblem,
    reconnect,
    closedAs,
    start: closedAs === null ? start : null,
    followUp,
    cancel,
  }
}

export type AgentReviewControls = ReturnType<typeof useAgentReview>
