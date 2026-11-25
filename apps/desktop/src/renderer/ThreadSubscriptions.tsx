import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type {
  Subscription,
  SubscriptionReason,
  ThreadPullRequest as OwnPullRequest,
} from "@glass/contracts"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { BellRing, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { endSubscriptionAtom, subscriptionsAtom } from "./threadsArea"

const reasonLabels: Record<SubscriptionReason, string> = {
  "failing-checks": "failing checks",
  "review-feedback": "review feedback",
  "changes-requested": "changes requested",
  "merge-conflict": "a merge conflict",
  "merged-or-closed": "merged or closed",
}

const pullRequestLabel = ({ pullRequest }: Subscription, own: OwnPullRequest | undefined) => {
  if (pullRequest !== null) return `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`

  return own === undefined
    ? "This Thread's PR, once it has one"
    : `This Thread's PR #${own.ref.number}`
}

export function ThreadSubscriptions(props: {
  threadId: string
  pullRequest: OwnPullRequest | undefined
}) {
  const subscriptions = Option.getOrUndefined(
    AsyncResult.value(useAtomValue(subscriptionsAtom(props.threadId))),
  )

  const end = useAtomSet(endSubscriptionAtom(props.threadId))

  if (subscriptions === undefined || subscriptions.length === 0) return null

  return (
    <>
      <div className="-mx-1 my-1 border-t" />
      <ul aria-label="Subscriptions">
        {subscriptions.map((subscription) => {
          const label = pullRequestLabel(subscription, props.pullRequest)

          return (
            <li key={subscription.id} className="flex items-start gap-2 px-2 py-1 text-xs">
              <BellRing aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate">{label}</div>
                <div className="text-muted-foreground">
                  {subscription.reasons.map((reason) => reasonLabels[reason]).join(", ")}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`End the Subscription to ${label}`}
                onClick={() => end(subscription.id)}
              >
                <X aria-hidden />
              </Button>
            </li>
          )
        })}
      </ul>
    </>
  )
}
