import { assert, it } from "@effect/vitest"
import type { AssistantMessage } from "@opencode-ai/sdk/v2/client"
import { DateTime } from "effect"
import { Input, machine, type History } from "./openCodeTurn"

const now = DateTime.makeUnsafe("2026-11-12T00:00:00Z")

const fresh = machine.begin("current", { message: "Continue", images: [], context: null }, now)

const prompted = machine.step(
  fresh,
  Input.Prompt({ turnId: "current", messageID: "current-prompt" }),
  now,
).state

const assistant: AssistantMessage = {
  id: "assistant",
  sessionID: "session",
  parentID: "current-prompt",
  role: "assistant",
  time: { created: 0 },
  modelID: "model",
  providerID: "provider",
  mode: "build",
  agent: "build",
  path: { cwd: "/work", root: "/work" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

it("does not let a previous Turn's snapshot or completed reply end the current Turn", () => {
  const foreignPrompt = machine.step(
    prompted,
    Input.Prompt({ turnId: "previous", messageID: "obsolete" }),
    now,
  )

  const foreignCompletion = machine.step(
    foreignPrompt.state,
    Input.Delivered({ turnId: "previous", messageID: "current-prompt" }),
    now,
  )

  assert.isFalse(foreignCompletion.state!.roots.has("obsolete"))
  assert.deepStrictEqual(foreignCompletion.commands, [])

  const stale = machine.step(
    prompted,
    Input.Snapshot({
      turnId: "previous",
      history: [],
      busy: false,
      delivering: false,
      permissions: [],
      questions: [],
    }),
    now,
  )

  const late = machine.step(
    stale.state,
    Input.Native({
      event: {
        id: "late",
        type: "message.updated",
        properties: {
          sessionID: "session",
          info: {
            ...assistant,
            parentID: "previous-prompt",
            time: { created: 0, completed: 1 },
            finish: "stop",
            error: { name: "MessageAbortedError", data: { message: "Aborted" } },
          },
        },
      },
    }),
    now,
  )

  assert.equal(late.state?.turn.id, "current")
  assert.deepStrictEqual([...stale.events, ...late.events], [])
  assert.deepStrictEqual(late.commands, [])
})

it("does not re-record unchanged parts when history is reconciled repeatedly", () => {
  const history: History = [
    {
      info: assistant,
      parts: [
        {
          id: "text",
          sessionID: "session",
          messageID: "assistant",
          type: "text",
          text: "A long reply",
        },
      ],
    },
  ]

  const snapshot = Input.Snapshot({
    turnId: "current",
    history,
    busy: true,
    delivering: false,
    permissions: [],
    questions: [],
  })

  const first = machine.step(prompted, snapshot, now)
  const second = machine.step(first.state, snapshot, now)
  assert.lengthOf(first.events, 1)
  assert.deepStrictEqual(second.events, [])

  const delta = Input.Native({
    event: {
      id: "delta",
      type: "message.part.delta",
      properties: {
        sessionID: "session",
        messageID: "assistant",
        partID: "text",
        field: "text",
        delta: "!",
      },
    },
  })

  const appended = machine.step(second.state, delta, now)
  const duplicate = machine.step(appended.state, delta, now)
  assert.lengthOf(appended.events, 1)
  assert.deepStrictEqual(duplicate.events, [])
})
