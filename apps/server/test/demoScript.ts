import type { Image } from "@glass/contracts"
import type { Schema } from "effect"
import {
  type FakeModelDelta,
  type FakeModelRequest,
  firstUserText,
  lastUserText,
} from "./fakeModelProvider"

export interface Tool {
  readonly name: string
  readonly arguments: Schema.JsonObject
}

interface Step {
  readonly thinking?: string
  readonly tools?: ReadonlyArray<Tool>
  readonly text?: string
}

type ScriptedTurn = readonly [message: string, steps: ReadonlyArray<Step>]

export const bash = (command: string): Tool => ({ name: "bash", arguments: { command } })

export const read = (path: string): Tool => ({ name: "read", arguments: { path } })

export const write = (path: string, content: string): Tool => ({
  name: "write",
  arguments: { path, content },
})

export const edit = (path: string, edits: Array<{ oldText: string; newText: string }>): Tool => ({
  name: "edit",
  arguments: { path, edits },
})

export const lines = (...parts: ReadonlyArray<string>) => parts.join("\n")

export const scriptedThread = ({
  name,
  images = () => [],
  turns,
}: {
  readonly name: string
  readonly images?: () => ReadonlyArray<Image>
  readonly turns: readonly [ScriptedTurn, ...ReadonlyArray<ScriptedTurn>]
}) => {
  const [[opening], ...followUps] = turns
  const scripts = new Map(turns)

  const reply = (input: FakeModelRequest): ReadonlyArray<FakeModelDelta> | undefined => {
    const steps = scripts.get(lastUserText(input))

    if (firstUserText(input) !== opening || steps === undefined) return undefined

    const { messages } = input
    const sinceUser = messages.slice(messages.findLastIndex(({ role }) => role === "user") + 1)
    const index = sinceUser.filter(({ role }) => role === "assistant").length
    const step = steps[index]

    if (step === undefined) return undefined

    const { thinking, tools = [], text } = step

    return [
      ...(thinking === undefined ? [] : [{ thinking }]),
      ...tools.map((tool, position) => ({
        toolCall: { id: `scripted-${messages.length}-${position}`, ...tool },
      })),
      ...(text === undefined ? [] : [{ text }]),
    ]
  }

  return { name, images, opening, followUps: followUps.map(([message]) => message), reply }
}

export type ScriptedThread = ReturnType<typeof scriptedThread>
