import {
  AskUserAnswered,
  AskUserCancelled,
  type AskUserResult,
  AskUserTimedOut,
  OutsideQuestion,
  type OutsideQuestionAnswer,
  OutsideQuestionNotWaiting,
} from "@glass/contracts"
import {
  Context,
  DateTime,
  Deferred,
  type Duration,
  Effect,
  Layer,
  Match,
  Option,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect"
import { randomUUID } from "node:crypto"

export const ASK_TIMEOUT_SECONDS = 10 * 60

/**
 * Shorter than the minute a typical MCP client waits before it gives up on a call.
 * Each notification resets that wait, so Glass's own limit is the one that ends the call.
 */
export const ASK_PROGRESS_SECONDS = 15

export class OutsideQuestionAlreadyWaiting extends Schema.TaggedError<OutsideQuestionAlreadyWaiting>()(
  "OutsideQuestionAlreadyWaiting",
  {},
) {}

interface Pending {
  readonly question: OutsideQuestion
  readonly session: string
  readonly slot: Deferred.Deferred<AskUserResult>
  readonly settled: Deferred.Deferred<void>
}

const timedOut = AskUserTimedOut.make({})

const cancelled = AskUserCancelled.make({})

const publish = (slot: Deferred.Deferred<AskUserResult>, result: AskUserResult) =>
  Deferred.succeed(slot, result).pipe(Effect.ignore)

export class OutsideQuestions extends Context.Service<
  OutsideQuestions,
  {
    readonly ask: (input: {
      readonly question: string
      readonly choices: ReadonlyArray<string>
      readonly session: string
      readonly askedBy: string
      readonly timeout: Duration.Duration
    }) => Effect.Effect<AskUserResult, OutsideQuestionAlreadyWaiting>
    readonly answer: (
      id: string,
      answer: OutsideQuestionAnswer,
    ) => Effect.Effect<void, OutsideQuestionNotWaiting>
    readonly watch: () => Stream.Stream<ReadonlyArray<OutsideQuestion>>
    readonly cancelAll: () => Effect.Effect<void>
  }
>()("@glass/server/OutsideQuestions") {
  static readonly layer = Layer.effect(
    OutsideQuestions,
    Effect.gen(function* () {
      const pending = yield* SubscriptionRef.make<ReadonlyArray<Pending>>([])

      const take = (id: string) =>
        SubscriptionRef.modify(pending, (items) => {
          const found = items.find((item) => item.question.id === id)

          return [
            found,
            found === undefined ? items : items.filter((item) => item.question.id !== id),
          ] as const
        })

      const settle = (id: string, result: AskUserResult) =>
        take(id).pipe(
          Effect.flatMap((found) =>
            found === undefined ? Effect.void : publish(found.slot, result),
          ),
        )

      const cancelAll = Effect.fnUntraced(function* () {
        const items = yield* SubscriptionRef.modify(pending, (current) => [current, []] as const)

        yield* Effect.forEach(items, (item) => publish(item.slot, cancelled), {
          discard: true,
          concurrency: "unbounded",
        })
        yield* Effect.forEach(items, (item) => Deferred.await(item.settled), {
          discard: true,
          concurrency: "unbounded",
        })
      })

      const ask = (input: {
        readonly question: string
        readonly choices: ReadonlyArray<string>
        readonly session: string
        readonly askedBy: string
        readonly timeout: Duration.Duration
      }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const slot = yield* Deferred.make<AskUserResult>()
            const settled = yield* Deferred.make<void>()

            const question = OutsideQuestion.make({
              id: randomUUID(),
              question: input.question,
              choices: [...input.choices],
              askedBy: input.askedBy,
              since: yield* DateTime.now,
            })

            const admitted = yield* SubscriptionRef.modify(pending, (items) =>
              items.some((item) => item.session === input.session)
                ? ([false, items] as const)
                : ([
                    true,
                    [...items, { question, session: input.session, slot, settled }],
                  ] as const),
            )

            if (!admitted) return yield* new OutsideQuestionAlreadyWaiting()
            yield* Effect.sleep(input.timeout).pipe(
              Effect.andThen(settle(question.id, timedOut)),
              Effect.forkScoped,
            )

            return yield* Deferred.await(slot).pipe(
              Effect.onInterrupt(() => settle(question.id, cancelled)),
              Effect.ensuring(Deferred.succeed(settled, undefined).pipe(Effect.ignore)),
            )
          }),
        )

      const answer = (id: string, given: OutsideQuestionAnswer) =>
        SubscriptionRef.modify(pending, (items) => {
          const found = items.find((item) => item.question.id === id)

          if (found === undefined) return [Option.none<Pending>(), items] as const

          const rejected = Match.value(given).pipe(
            Match.tag("Choice", ({ choice }) => !found.question.choices.includes(choice)),
            Match.tag("Text", () => false),
            Match.exhaustive,
          )

          if (rejected) return [Option.none<Pending>(), items] as const

          return [Option.some(found), items.filter((item) => item.question.id !== id)] as const
        }).pipe(
          Effect.flatMap((found) => {
            if (Option.isNone(found)) return Effect.fail(new OutsideQuestionNotWaiting())

            const answered = Match.value(given).pipe(
              Match.tag("Choice", ({ choice }) =>
                AskUserAnswered.make({ answer: choice, by: "choice" }),
              ),
              Match.tag("Text", ({ text }) => AskUserAnswered.make({ answer: text, by: "text" })),
              Match.exhaustive,
            )

            return publish(found.value.slot, answered)
          }),
        )

      return OutsideQuestions.of({
        ask,
        answer,
        watch: () =>
          SubscriptionRef.changes(pending).pipe(
            Stream.map((items) => items.map((item) => item.question)),
          ),
        cancelAll,
      })
    }),
  )
}
