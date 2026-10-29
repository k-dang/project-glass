import type { Schema } from "effect"
import { copyFile, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface FakeAgentSettings {
  readonly ready: boolean
  readonly output: string
  readonly exitCode?: number
  readonly stderr?: string
  readonly helpOutput?: string
  readonly modelsOutput?: string
  readonly gate?: string
  readonly delay?: number
  readonly hangAt?: "auth" | "generate" | "help"
}

export const installFakeAgent = async (
  directory: string,
  name: string,
  initial: FakeAgentSettings,
) => {
  const command = join(directory, name)
  await copyFile(new URL("./fakeAgent.cjs", import.meta.url), command)
  await writeFile(`${command}.log`, "")

  const configure = (settings: FakeAgentSettings) =>
    writeFile(`${command}.json`, JSON.stringify(settings))

  await configure(initial)

  return { command, configure, log: () => readFile(`${command}.log`, "utf8") }
}

export const piCliModels = ["provider   model", "anthropic  claude-sonnet-5-5"].join("\n")

export interface PiCliAssistant {
  readonly stopReason?: string
  readonly errorMessage?: string
  readonly content?: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
}

export const piCliOutput = (assistant: PiCliAssistant) =>
  [
    { type: "agent_start" },
    {
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "prompt" }] },
        { role: "assistant", content: [], stopReason: "stop", ...assistant },
      ],
    },
    { type: "agent_settled", aborted: false },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n")

export const piCliAnswer = (text: string) => piCliOutput({ content: [{ type: "text", text }] })

/** Claude Code's `--output-format json` envelope, with the answer as its result text. */
export const claudeAnswer = (answer: Schema.Json) =>
  JSON.stringify({ result: JSON.stringify(answer) })
