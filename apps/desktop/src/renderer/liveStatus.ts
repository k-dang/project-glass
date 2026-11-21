import { useAtomValue } from "@effect/atom-react"
import { type PullRequest, type PullRequestStatus, withStatus } from "@glass/contracts"
import { Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { useMemo } from "react"
import { Backend, backendRuntime } from "./backend"
import { watched } from "./watched"

const statusAtoms = new WeakMap<
  PullRequest,
  Atom.Atom<AsyncResult.AsyncResult<PullRequestStatus, unknown>>
>()

const statusAtom = (loaded: PullRequest) => {
  const existing = statusAtoms.get(loaded)

  if (existing !== undefined) return existing

  const atom = watched(
    backendRuntime.atom(
      Backend.use((backend) => backend.GetPullRequestStatus({ pullRequestId: loaded.id })),
    ),
  )

  statusAtoms.set(loaded, atom)

  return atom
}

const noStatusAtom = Atom.make(AsyncResult.initial<PullRequestStatus>())

export function useLiveStatus(pullRequest: PullRequest): PullRequest
export function useLiveStatus(pullRequest: PullRequest | null): PullRequest | null
export function useLiveStatus(pullRequest: PullRequest | null) {
  const latest = Option.getOrNull(
    AsyncResult.value(useAtomValue(pullRequest === null ? noStatusAtom : statusAtom(pullRequest))),
  )

  return useMemo(
    () => (pullRequest === null || latest === null ? pullRequest : withStatus(pullRequest, latest)),
    [pullRequest, latest],
  )
}
