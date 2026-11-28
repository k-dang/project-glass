import {
  defaultSubscriptionKinds,
  Event,
  eventKindWords,
  PullRequestEventKind,
  PullRequestSubject,
  Subscription,
} from "@glass/contracts"
import { Context, Effect, Match, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { GitHubSource } from "../GitHubSource"
import { Subscriptions } from "../Subscriptions"
import { Transcripts } from "../Transcripts"
import { acting, explained, GlassToolFailure, readOnly } from "./glassTools"
import { McpCaller } from "./McpCredentials"
import { forThreadsAndTheGlobalChat } from "./toolAudience"

const MAX_NOTE_CHARS = 2_000

const kindList = PullRequestEventKind.literals
  .map((kind) => `${kind}: ${eventKindWords[kind]}`)
  .join(", ")

const Subscribe = Tool.make("subscribe", {
  description: `Subscribes you to a subject, so Glass tells you about the Events that happen to it after your Turn ends. A PR is the only subject you can subscribe to; Glass subscribes you to the work you start by itself. Use it when the user asks you to look after a PR, such as keeping it green or handling its review feedback, or to be told when a PR you depend on merges. The PR must be open, in a repository the user follows in Glass. Glass replies with what already stands on the PR as Events in standing, or with null there when it hasn't read the PR in detail yet; then its first read sends what stands in an Update. After that, Glass tells what changes. When you are idle, you get one Update with every new Event since the last one, if at least one is of a kind you asked for. Subscribing again to the same subject replaces its kinds and note, and tells only the Events from then on. A Subscription to a PR ends when the PR merges or closes. Glass allows this only in a Turn a message started, not in one with a glass_update block, nor in one that began by itself.`,
  parameters: Schema.Struct({
    subject: PullRequestSubject.annotate({
      description:
        'What to subscribe to, such as {"_tag":"PullRequest","pullRequest":{"owner":"octo-org","repo":"hello-world","number":6}}.',
    }),
    kinds: Schema.optional(
      Schema.Array(PullRequestEventKind)
        .check(Schema.isMinLength(1), Schema.isUnique())
        .annotate({
          description: `The kinds of Event that start an Update. ${kindList}. Defaults to ${defaultSubscriptionKinds.join(", ")}.`,
        }),
    ),
    note: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_NOTE_CHARS)).annotate({
      description:
        "In your own words, what the user asked you to do about it. Glass gives it back to you with what happened.",
    }),
  }),
  success: Schema.Struct({
    subscription: Subscription,
    standing: Schema.NullOr(Schema.Array(Event)),
  }),
  failure: GlassToolFailure,
}).annotateMerge(acting.pipe(Context.merge(forThreadsAndTheGlobalChat)))

const ListSubscriptions = Tool.make("list_subscriptions", {
  description:
    "Lists your Subscriptions: what each is about, which kinds of Event start an Update, and the note you left.",
  success: Schema.Struct({ subscriptions: Schema.Array(Subscription) }),
  failure: GlassToolFailure,
}).annotateMerge(readOnly.pipe(Context.merge(forThreadsAndTheGlobalChat)))

const EndSubscription = Tool.make("end_subscription", {
  description:
    "Ends one of your Subscriptions, so Glass stops telling you about that subject. Use it when the user asks you to stop looking after it.",
  parameters: Schema.Struct({
    subscriptionId: Schema.String.annotate({
      description: "The Subscription's id, from list_subscriptions.",
    }),
  }),
  success: Schema.Struct({ ended: Schema.Literal(true) }),
  failure: GlassToolFailure,
}).annotateMerge(acting.pipe(Context.merge(forThreadsAndTheGlobalChat)))

export const SubscriptionTools = Toolkit.make(Subscribe, ListSubscriptions, EndSubscription)

export const SubscriptionToolHandlers = SubscriptionTools.toLayer(
  Effect.gen(function* () {
    const subscriptions = yield* Subscriptions
    const gitHub = yield* GitHubSource
    const transcripts = yield* Transcripts

    const calling = McpCaller.current.pipe(
      Effect.flatMap((caller) =>
        Match.value(caller).pipe(
          Match.tagsExhaustive({
            Thread: ({ threadId, turnId }) =>
              Effect.succeed({ subscriber: threadId, askedIn: { threadId, turnId } }),
            GlobalChat: ({ globalChatId, sessionId }) =>
              transcripts.runningTurn(sessionId).pipe(
                Effect.mapError(explained),
                Effect.map((turnId) => ({
                  subscriber: globalChatId,
                  askedIn: { threadId: sessionId, turnId },
                })),
              ),
            OutsideAgent: () =>
              Effect.fail(
                new GlassToolFailure({
                  message: "Only a Thread's agent and the Global chat have Subscriptions.",
                }),
              ),
          }),
        ),
      ),
    )

    return SubscriptionTools.of({
      subscribe: ({ subject, kinds, note }) =>
        calling.pipe(
          Effect.flatMap(({ subscriber, askedIn }) =>
            subscriptions
              .subscribe(subscriber, askedIn, {
                subject: gitHub.subject(subject.pullRequest),
                kinds: kinds ?? defaultSubscriptionKinds,
                note,
              })
              .pipe(Effect.mapError(explained)),
          ),
          Effect.flatMap((subscription) =>
            gitHub
              .standing(subject.pullRequest)
              .pipe(Effect.map((standing) => ({ subscription, standing }))),
          ),
        ),
      list_subscriptions: () =>
        calling.pipe(
          Effect.flatMap(({ subscriber }) =>
            subscriptions.list(subscriber).pipe(Effect.mapError(explained)),
          ),
          Effect.map((listed) => ({ subscriptions: listed })),
        ),
      end_subscription: ({ subscriptionId }) =>
        Effect.gen(function* () {
          const { subscriber } = yield* calling

          const ended = yield* subscriptions
            .end(subscriber, subscriptionId)
            .pipe(Effect.mapError(explained))

          if (!ended)
            return yield* new GlassToolFailure({
              message:
                "You have no Subscription with that id. list_subscriptions names the ones you have.",
            })

          return { ended: true as const }
        }),
    })
  }),
)
