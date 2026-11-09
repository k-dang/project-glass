import {
  AskFailure,
  type AskAnswer,
  type AskPlace,
  type PullRequestRef,
  type Revision,
} from "@glass/contracts"
import { Context, Effect, Layer } from "effect"
import { AskAgentAnswer, askInstructions, askPrompt } from "./askPrompt"
import { checkoutRunFailure, CheckoutRuns } from "./CheckoutRuns"
import { GitHubClient } from "./github/GitHubClient"
import { lineInFiles } from "./github/patchLines"
import { Deadlines } from "./ServerConfig"

export class Asks extends Context.Service<
  Asks,
  {
    readonly ask: (
      pr: PullRequestRef,
      revision: Revision,
      place: AskPlace,
      question: string,
    ) => Effect.Effect<AskAnswer, AskFailure>
  }
>()("@glass/server/Asks") {
  static readonly layer = Layer.effect(
    Asks,
    Effect.gen(function* () {
      const checkoutRuns = yield* CheckoutRuns
      const github = yield* GitHubClient
      const deadlines = yield* Deadlines

      const ask = Effect.fn("Asks.ask")(
        function* (pr: PullRequestRef, revision: Revision, place: AskPlace, question: string) {
          const runner = yield* checkoutRuns.select("agentReviews")

          const { answer } = yield* runner.run({
            pr,
            revision,
            subject: "answer",
            timeout: deadlines.askMs,
            read: github.tourInput,
            task: (input) => {
              const found = lineInFiles(input.files, place.path, place.side, place.line)

              if (found === null)
                return Effect.fail(
                  checkoutRunFailure(
                    "stale-revision",
                    "That line isn't in the diff Glass loaded. Reload, then ask again.",
                    runner.identity,
                  ),
                )

              return Effect.succeed({
                instructions: askInstructions,
                prompt: askPrompt(input, found.file, place, found.text, question),
                answer: AskAgentAnswer,
                tools: "read-only",
              })
            },
          })

          return { answer: answer.answer, runner: runner.identity }
        },
        Effect.scoped,
        Effect.mapError(
          ({ reason, message, runner }) => new AskFailure({ reason, message, runner }),
        ),
      )

      return Asks.of({ ask })
    }),
  )
}
