import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { eventKindWords, referenceText } from "@glass/contracts"
import { Option, Predicate } from "effect"
import { AsyncResult } from "effect/reactivity"
import { BellRing, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { endSubscriptionAtom, subscriptionsAtom } from "./threadsArea"

export function ThreadSubscriptions(props: { threadId: string }) {
  const subscriptions = Option.getOrUndefined(
    AsyncResult.value(useAtomValue(subscriptionsAtom(props.threadId))),
  )

  const end = useAtomSet(endSubscriptionAtom(props.threadId))

  const toPullRequests = (subscriptions ?? []).flatMap((subscription) =>
    Predicate.isTagged(subscription.subject, "PullRequest")
      ? [{ subscription, pullRequest: subscription.subject.pullRequest }]
      : [],
  )

  if (toPullRequests.length === 0) return null

  return (
    <>
      <div className="-mx-1 my-1 border-t" />
      <ul aria-label="Subscriptions">
        {toPullRequests.map(({ subscription, pullRequest }) => {
          const label = referenceText(pullRequest)

          return (
            <li key={subscription.id} className="flex items-start gap-2 px-2 py-1 text-xs">
              <BellRing aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate">{label}</div>
                <div className="text-muted-foreground">
                  {subscription.kinds.map((kind) => eventKindWords[kind]).join(", ")}
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
