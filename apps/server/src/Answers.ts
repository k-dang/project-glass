import { type GivenAnswer, type QuestionNotOpen, ThreadError } from "@glass/contracts"
import { type Array as Arr, Context, Effect, Layer, Match } from "effect"
import { GlobalChat } from "./GlobalChat"
import { Questions } from "./Questions"
import { Threads } from "./Threads"

export class Answers extends Context.Service<
  Answers,
  {
    readonly answer: (
      answers: Arr.NonEmptyReadonlyArray<GivenAnswer>,
    ) => Effect.Effect<void, QuestionNotOpen | ThreadError>
  }
>()("@glass/server/Answers") {
  static readonly layer = Layer.effect(
    Answers,
    Effect.gen(function* () {
      const questions = yield* Questions
      const threads = yield* Threads
      const globalChat = yield* GlobalChat

      return Answers.of({
        answer: (given) =>
          questions.answer(given, (asker, answered) =>
            Match.value(asker).pipe(
              Match.tagsExhaustive({
                OutsideAgent: () => Effect.void,
                Thread: ({ threadId }) =>
                  threads
                    .deliverAnswers(threadId, answered)
                    .pipe(
                      Effect.catchTag("ThreadNotFound", () =>
                        Effect.fail(new ThreadError({ message: "That Thread is gone." })),
                      ),
                    ),
                GlobalChat: ({ sessionId }) => globalChat.deliverAnswers(sessionId, answered),
              }),
            ),
          ),
      })
    }),
  )
}
