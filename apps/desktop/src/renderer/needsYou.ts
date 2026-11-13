import {
  type AgentReviewDone,
  AgentReviewFinished,
  ChecksFailing,
  type NeedsYouItem,
  type PullRequestNeedsYou,
  referenceKey,
} from "@glass/contracts"
import { type Cause, type DateTime, Match, Option, Schema, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { type BackendError, Backend, backendRuntime } from "./backend"
import { queueRefreshAtom } from "./queue"

export const needsYouStreamAtom = backendRuntime
  .atom(Stream.unwrap(Backend.useSync((backend) => backend.WatchNeedsYou())))
  .pipe(Atom.keepAlive)

export type NeedsYouResult = AsyncResult.AsyncResult<
  ReadonlyArray<NeedsYouItem>,
  BackendError | Cause.NoSuchElementError
>

export const watchedNeedsYouAtom = Atom.make((get): NeedsYouResult => {
  get(queueRefreshAtom)

  return get(needsYouStreamAtom)
})

export const needsYouCount = (result: NeedsYouResult): Option.Option<number> =>
  AsyncResult.isSuccess(result) ? Option.some(result.value.length) : Option.none()

export const needsYouKey = (item: NeedsYouItem): string =>
  Match.valueTags(item, {
    Agent: ({ agent }) => `agent:${agent.id}`,
    OutsideQuestion: ({ id }) => `ask:${id}`,
    PullRequest: ({ pullRequest }) => `pr:${referenceKey(pullRequest.ref)}`,
    GlobalConversation: () => "global",
  })

export const finishedAgentReviewOf = (item: PullRequestNeedsYou) =>
  item.reasons.find(Schema.is(AgentReviewFinished))

export const failingChecksOf = (item: PullRequestNeedsYou) =>
  item.reasons.find(Schema.is(ChecksFailing))?.failing ?? []

export const reviewDoneOf = (item: PullRequestNeedsYou): AgentReviewDone | null => {
  const review = finishedAgentReviewOf(item)

  return review === undefined
    ? null
    : { pullRequest: item.pullRequest.ref, writtenAt: review.writtenAt }
}

export const markDoneAtom = backendRuntime.fn((review: AgentReviewDone) =>
  Backend.use((backend) => backend.MarkAgentReviewDone(review)),
)

export const markTurnSeenAtom = backendRuntime.fn(
  (seen: { readonly agentId: string; readonly endedAt: DateTime.Utc }) =>
    Backend.use((backend) => backend.MarkTurnSeen(seen)),
)
