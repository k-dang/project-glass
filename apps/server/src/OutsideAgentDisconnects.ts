import type { OutsideAgentNotFound } from "@glass/contracts"
import { Context, Effect, Layer } from "effect"
import { CheckIns } from "./CheckIns"
import { OutsideAgents } from "./OutsideAgents"
import { Questions } from "./Questions"

export class OutsideAgentDisconnects extends Context.Service<
  OutsideAgentDisconnects,
  { readonly disconnect: (agentId: string) => Effect.Effect<void, OutsideAgentNotFound> }
>()("@glass/server/OutsideAgentDisconnects") {
  static readonly layer = Layer.effect(
    OutsideAgentDisconnects,
    Effect.gen(function* () {
      const outsideAgents = yield* OutsideAgents
      const questions = yield* Questions
      const checkIns = yield* CheckIns

      return OutsideAgentDisconnects.of({
        disconnect: Effect.fn("OutsideAgentDisconnects.disconnect")(function* (agentId) {
          yield* outsideAgents.revoke(agentId)
          yield* Effect.all([questions.forgetAgent(agentId), checkIns.forgetAgent(agentId)], {
            concurrency: "unbounded",
          })
        }),
      })
    }),
  )
}
