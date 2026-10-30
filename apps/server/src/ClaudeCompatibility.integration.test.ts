import { assert, it } from "@effect/vitest"
import { AllowRequest, AnswerQuestion, isWaiting } from "@glass/contracts"
import { Effect, Predicate } from "effect"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { claudeIntegrationFixture, settled } from "../test/agentsFixture"

it.live("connects the real Claude CLI's permission and Question callbacks to Glass", () =>
  Effect.gen(function* () {
    const f = yield* claudeIntegrationFixture()

    const agent = yield* f.start("Please run `touch compatible.txt`", {
      engine: "claude-code",
      model: null,
      effort: null,
      permissionMode: "default",
    })

    const waiting = yield* f.transcript(agent.id, (turns) =>
      turns.some(({ parts }) => parts.some(isWaiting)),
    )

    const permission = waiting[0]?.parts.find(isWaiting)
    assert.ok(Predicate.isTagged(permission, "PermissionRequest"))
    assert.equal(permission.toolName, "Bash")
    yield* f.client.AnswerRequest({
      agentId: agent.id,
      requestId: permission.requestId,
      answer: AllowRequest.make({}),
    })
    const allowed = yield* f.transcript(agent.id, settled(1))
    assert.equal(allowed[0]?.ended?.ending._tag, "Done")
    assert.equal(
      yield* Effect.promise(() => readFile(join(f.worktree(agent.name), "compatible.txt"), "utf8")),
      "",
    )

    yield* f.send(agent.id, "Please ask which files to read")

    const asking = yield* f.transcript(
      agent.id,
      (turns) => turns[1]?.parts.some(isWaiting) === true,
    )

    const question = asking[1]?.parts.find(isWaiting)
    assert.ok(Predicate.isTagged(question, "Question"))
    yield* f.client.AnswerRequest({
      agentId: agent.id,
      requestId: question.requestId,
      answer: AnswerQuestion.make({ answers: [{ chosen: ["Only the README"], text: null }] }),
    })
    const answered = yield* f.transcript(agent.id, settled(2))
    assert.equal(answered[1]?.ended?.ending._tag, "Done")
    assert.isTrue(
      answered[1]?.parts.some(
        (part) => Predicate.isTagged(part, "Text") && part.text.includes("Only the README"),
      ),
    )
  }),
)
