import {
  defaultSubscriptionKinds,
  EventKind,
  eventKindWords,
  Subscription,
  SubscriptionSubject,
} from "@glass/contracts"
import { Context, Effect, Match, Predicate, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { GitHubSource } from "../GitHubSource"
import { Subscriptions } from "../Subscriptions"
import { acting, explained, GlassToolFailure, readOnly } from "./glassTools"
import { McpCaller } from "./McpCredentials"
import { forThreads } from "./toolAudience"

const MAX_NOTE_CHARS = 2_000

const kindList = EventKind.literals.map((kind) => `${kind}: ${eventKindWords[kind]}`).join(", ")

const Subscribe = Tool.make("subscribe", {
  description: `Subscribes your Thread to a subject, so Glass tells it about the Events that happen to it after your Turn ends. A PR is the only subject so far: use it when the user asks you to look after a PR, such as keeping it green or handling its review feedback, or to be told when a PR you depend on merges. The PR must be open, in a repository the user follows in Glass. When Glass first reads the PR for a Subscription it reports what already stands on it, then what changes. When your Thread is idle, it gets one Update with every new Event since the last one, if at least one is of a kind you asked for. Subscribing again to the same subject replaces its kinds and note, and tells only the Events from then on. A Subscription to a PR ends when the PR merges or closes. Glass allows this only in a Turn a message started, not in one with a glass_update or glass_started_work_update block, nor in one that began by itself.`,
  parameters: Schema.Struct({
    subject: SubscriptionSubject.annotate({
      description:
        'What to subscribe to, such as {"_tag":"PullRequest","pullRequest":{"owner":"octo-org","repo":"hello-world","number":6}}.',
    }),
    kinds: Schema.optional(
      Schema.Array(EventKind)
        .check(Schema.isMinLength(1), Schema.isUnique())
        .annotate({
          description: `The kinds of Event that start an Update. ${kindList}. Defaults to ${defaultSubscriptionKinds.join(", ")}.`,
        }),
    ),
    note: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_NOTE_CHARS)).annotate({
      description:
        "In your own words, what the user asked you to do about it. Glass gives it back to your Thread with what happened.",
    }),
  }),
  success: Schema.Struct({ subscription: Subscription }),
  failure: GlassToolFailure,
}).annotateMerge(acting.pipe(Context.merge(forThreads)))

const ListSubscriptions = Tool.make("list_subscriptions", {
  description:
    "Lists your Thread's Subscriptions: what each is about, which kinds of Event start an Update, and the note you left.",
  success: Schema.Struct({ subscriptions: Schema.Array(Subscription) }),
  failure: GlassToolFailure,
}).annotateMerge(readOnly.pipe(Context.merge(forThreads)))

const EndSubscription = Tool.make("end_subscription", {
  description:
    "Ends one of your Thread's Subscriptions, so Glass stops telling it about that subject. Use it when the user asks you to stop looking after it.",
  parameters: Schema.Struct({
    subscriptionId: Schema.String.annotate({
      description: "The Subscription's id, from list_subscriptions.",
    }),
  }),
  success: Schema.Struct({ ended: Schema.Literal(true) }),
  failure: GlassToolFailure,
}).annotateMerge(acting.pipe(Context.merge(forThreads)))

export const SubscriptionTools = Toolkit.make(Subscribe, ListSubscriptions, EndSubscription)

const callingThread = McpCaller.current.pipe(
  Effect.flatMap((caller) =>
    Predicate.isTagged(caller, "Thread")
      ? Effect.succeed(caller)
      : Effect.fail(new GlassToolFailure({ message: "Only a Thread's agent has Subscriptions." })),
  ),
)

export const SubscriptionToolHandlers = SubscriptionTools.toLayer(
  Effect.gen(function* () {
    const subscriptions = yield* Subscriptions
    const gitHub = yield* GitHubSource

    const admitted = (subject: SubscriptionSubject) =>
      Match.valueTags(subject, { PullRequest: ({ pullRequest }) => gitHub.subject(pullRequest) })

    return SubscriptionTools.of({
      subscribe: ({ subject, kinds, note }) =>
        callingThread.pipe(
          Effect.flatMap(({ threadId, turnId }) =>
            subscriptions
              .subscribe(threadId, turnId, {
                subject: admitted(subject),
                kinds: kinds ?? defaultSubscriptionKinds,
                note,
              })
              .pipe(Effect.mapError(explained)),
          ),
          Effect.map((subscription) => ({ subscription })),
        ),
      list_subscriptions: () =>
        callingThread.pipe(
          Effect.flatMap(({ threadId }) =>
            subscriptions.list(threadId).pipe(Effect.mapError(explained)),
          ),
          Effect.map((listed) => ({ subscriptions: listed })),
        ),
      end_subscription: ({ subscriptionId }) =>
        Effect.gen(function* () {
          const { threadId } = yield* callingThread

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
