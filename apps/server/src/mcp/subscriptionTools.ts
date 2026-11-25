import {
  defaultSubscriptionReasons,
  PullRequestRef,
  Subscription,
  SubscriptionReason,
} from "@glass/contracts"
import { Context, Effect, Predicate, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Subscriptions } from "../Subscriptions"
import { acting, explained, GlassToolFailure, readOnly } from "./glassTools"
import { McpCaller } from "./McpCredentials"
import { forThreads } from "./toolAudience"

const MAX_NOTE_CHARS = 2_000

const SubscribeToPullRequest = Tool.make("subscribe_to_pull_request", {
  description:
    "Subscribes your Thread to a PR, so Glass tells it what happens to that PR after your Turn ends. Use it when the user asks you to look after a PR, such as keeping it green or handling its review feedback, or to be told when a PR you depend on merges. Leave pullRequest out for your Thread's own PR: the PR of the branch your folder has checked out, which you can subscribe to before you open it. A named PR must be in a repository the user follows in Glass. Subscribing again to the same PR replaces its reasons and note. A Subscription ends when its PR merges or closes, after telling your Thread if you asked for merged-or-closed. Glass allows this only in a Turn started by the user's message, or by a message from the Thread or Global chat that created your Thread. It refuses in a Turn with a glass_pull_request_update or glass_started_work_update block, in one that began by itself when background work reported back, and in one another agent's message started.",
  parameters: Schema.Struct({
    pullRequest: Schema.optional(
      PullRequestRef.annotate({ description: "The PR. Leave it out for your Thread's own PR." }),
    ),
    reasons: Schema.optional(
      Schema.Array(SubscriptionReason)
        .check(Schema.isMinLength(1), Schema.isUnique())
        .annotate({
          description: `What your Thread is told about. failing-checks: a check failed. review-feedback: a Review thread waits for a reply. changes-requested: a reviewer requested changes. merge-conflict: the PR conflicts with its base. merged-or-closed: the PR merged or closed. Defaults to ${defaultSubscriptionReasons.join(", ")}.`,
        }),
    ),
    note: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_NOTE_CHARS)).annotate({
      description:
        "In your own words, what the user asked you to do about this PR. Glass gives it back to your Thread with what happened.",
    }),
  }),
  success: Schema.Struct({ subscription: Subscription }),
  failure: GlassToolFailure,
}).annotateMerge(acting.pipe(Context.merge(forThreads)))

const ListSubscriptions = Tool.make("list_subscriptions", {
  description:
    "Lists your Thread's Subscriptions: each PR it is told about, for which reasons, and the note you left. A null pullRequest is your Thread's own PR.",
  success: Schema.Struct({ subscriptions: Schema.Array(Subscription) }),
  failure: GlassToolFailure,
}).annotateMerge(readOnly.pipe(Context.merge(forThreads)))

const EndSubscription = Tool.make("end_subscription", {
  description:
    "Ends one of your Thread's Subscriptions, so Glass stops telling it about that PR. Use it when the user asks you to stop looking after a PR.",
  parameters: Schema.Struct({
    subscriptionId: Schema.String.annotate({
      description: "The Subscription's id, from list_subscriptions.",
    }),
  }),
  success: Schema.Struct({ ended: Schema.Literal(true) }),
  failure: GlassToolFailure,
}).annotateMerge(acting.pipe(Context.merge(forThreads)))

export const SubscriptionTools = Toolkit.make(
  SubscribeToPullRequest,
  ListSubscriptions,
  EndSubscription,
)

const callingThread = McpCaller.current.pipe(
  Effect.flatMap((caller) =>
    Predicate.isTagged(caller, "Thread")
      ? Effect.succeed(caller.threadId)
      : Effect.fail(new GlassToolFailure({ message: "Only a Thread's agent has Subscriptions." })),
  ),
)

export const SubscriptionToolHandlers = SubscriptionTools.toLayer(
  Effect.gen(function* () {
    const subscriptions = yield* Subscriptions

    return SubscriptionTools.of({
      subscribe_to_pull_request: ({ pullRequest, reasons, note }) =>
        callingThread.pipe(
          Effect.flatMap((threadId) =>
            subscriptions
              .subscribe(threadId, {
                pullRequest: pullRequest ?? null,
                reasons: reasons ?? defaultSubscriptionReasons,
                note,
              })
              .pipe(Effect.mapError(explained)),
          ),
          Effect.map((subscription) => ({ subscription })),
        ),
      list_subscriptions: () =>
        callingThread.pipe(
          Effect.flatMap((threadId) =>
            subscriptions.list(threadId).pipe(Effect.mapError(explained)),
          ),
          Effect.map((listed) => ({ subscriptions: listed })),
        ),
      end_subscription: ({ subscriptionId }) =>
        Effect.gen(function* () {
          const threadId = yield* callingThread

          const ended = yield* subscriptions
            .end(threadId, subscriptionId)
            .pipe(Effect.mapError(explained))

          if (!ended)
            return yield* new GlassToolFailure({
              message:
                "Your Thread has no Subscription with that id. list_subscriptions names the ones it has.",
            })

          return { ended: true as const }
        }),
    })
  }),
)
