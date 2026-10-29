import {
  AskFailure,
  type AskAnswer,
  type AskPlace,
  type PullRequestRef,
  type Revision,
} from "@glass/contracts"
import { Context, Effect, Layer, Predicate } from "effect"
import { AskAgentAnswer, askInstructions, askPrompt } from "./askPrompt"
import { checkoutRunFailure, CheckoutRuns } from "./CheckoutRuns"
import { GitHubClient } from "./github/GitHubClient"
import { lineInPatch } from "./github/patchLines"
import { ServerConfig } from "./ServerConfig"

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
      const config = yield* ServerConfig

      const ask = Effect.fn("Asks.ask")(
        function* (pr: PullRequestRef, revision: Revision, place: AskPlace, question: string) {
          const runner = yield* checkoutRuns.select()

          const answer = yield* runner.run({
            pr,
            revision,
            subject: "answer",
            timeout: config.askTimeoutMs,
            read: github.tourInput,
            task: (input) => {
              const file = input.files.find((candidate) => candidate.path === place.path)

              const lineText =
                file !== undefined && Predicate.isTagged(file.patch, "TextPatch")
                  ? lineInPatch(file.patch.hunks, place.side, place.line)
                  : null

              if (file === undefined || lineText === null)
                return Effect.fail(
                  checkoutRunFailure(
                    "stale-revision",
                    "That line isn't in the diff Glass loaded. Reload, then ask again.",
                    runner.identity,
                  ),
                )

              return Effect.succeed({
                instructions: askInstructions,
                prompt: askPrompt(input, file, place, lineText, question),
                answer: AskAgentAnswer,
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
