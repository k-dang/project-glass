import {
  AskUserAnswered,
  AskUserCancelled,
  type AskUserResult,
  AskUserTimedOut,
  OutsideQuestion,
  type OutsideQuestionAnswer,
  OutsideQuestionNotWaiting,
} from "@glass/contracts"
import { Context, DateTime, type Duration, Effect, Layer, Match, Option, type Stream } from "effect"
import { randomUUID } from "node:crypto"
import { type AlreadyWaiting, inboxWaitsOf } from "./inboxWaits"

export const ASK_TIMEOUT_SECONDS = 10 * 60

// WARNING: Shorter than the minute a typical MCP client waits on a call; each notification resets that wait, so Glass's limit ends the call.
export const ASK_PROGRESS_SECONDS = 15

export class OutsideQuestions extends Context.Service<
  OutsideQuestions,
  {
    readonly ask: (input: {
      readonly question: string
      readonly choices: ReadonlyArray<string>
      readonly session: string
      readonly askedBy: string
      readonly timeout: Duration.Duration
    }) => Effect.Effect<AskUserResult, AlreadyWaiting>
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
      const waits = yield* inboxWaitsOf<OutsideQuestion, AskUserResult>({
        idOf: ({ id }) => id,
        timedOut: AskUserTimedOut.make({}),
        cancelled: AskUserCancelled.make({}),
      })

      return OutsideQuestions.of({
        ask: Effect.fnUntraced(function* ({ question, choices, session, askedBy, timeout }) {
          const asked = OutsideQuestion.make({
            id: randomUUID(),
            question,
            choices: [...choices],
            askedBy,
            since: yield* DateTime.now,
          })

          return yield* waits.wait(asked, session, timeout)
        }),
        answer: Effect.fnUntraced(function* (id, given) {
          const question = yield* waits.find(id)

          const answered = Option.flatMap(question, ({ choices }) =>
            Match.value(given).pipe(
              Match.tag("Choice", ({ choice }) =>
                choices.includes(choice)
                  ? Option.some(AskUserAnswered.make({ answer: choice, by: "choice" }))
                  : Option.none(),
              ),
              Match.tag("Text", ({ text }) =>
                Option.some(AskUserAnswered.make({ answer: text, by: "text" })),
              ),
              Match.exhaustive,
            ),
          )

          if (Option.isNone(answered) || !(yield* waits.resolve(id, answered.value)))
            yield* new OutsideQuestionNotWaiting()
        }),
        watch: waits.watch,
        cancelAll: waits.cancelAll,
      })
    }),
  )
}
