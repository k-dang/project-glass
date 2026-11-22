import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { type ScriptedReply, scriptedAgentRunners } from "../test/scriptedAgentRunners"
import { BranchNames } from "./BranchNames"

const suggest = Effect.fnUntraced(function* (reply: ScriptedReply) {
  const runners = yield* scriptedAgentRunners({ reply })

  const branchNames = yield* BranchNames.pipe(
    Effect.provide(
      BranchNames.layer.pipe(Layer.provide(runners.layer), Layer.provide(NodeFileSystem.layer)),
    ),
  )

  return {
    suggested: yield* branchNames.suggest("The login button errors"),
    selections: runners.selections,
  }
})

it.effect("asks Claude Code for a branch name and keeps it a valid ref", () =>
  Effect.gen(function* () {
    const { suggested, selections } = yield* suggest({
      answer: { branch: " Fix/Login  Button..Errors!/ " },
    })

    assert.deepStrictEqual(suggested, Option.some("fix/login-button-errors"))
    assert.deepStrictEqual(selections, ["claude-code"])
  }),
)

it.effect("suggests nothing when Claude Code can't answer", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual((yield* suggest({ fail: "not-installed" })).suggested, Option.none())
    assert.deepStrictEqual((yield* suggest({ answer: { branch: "!!!" } })).suggested, Option.none())
  }),
)
