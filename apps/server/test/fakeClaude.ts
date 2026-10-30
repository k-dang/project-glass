import { Effect, Schema } from "effect"
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ToolInput } from "../src/agentHost/toolCalls"
import { eventually } from "./eventually"

export type FakeClaudeStep =
  | { readonly text: string }
  | { readonly thinking: string }
  | {
      readonly toolCall: {
        readonly id: string
        readonly name: string
        readonly input: ToolInput
        readonly output: string
        readonly isError?: boolean
        readonly parentToolCallId?: string
      }
    }

export interface FakeClaudeSettings {
  /**
   * Text may hold `{model}` and `{effort}`, which the fake fills with what it was set to, and
   * `{earlier}`, the session's earlier prompts it remembers. Tool calls ask permission as Claude
   * Code would in the Permission mode the fake is in.
   */
  readonly reply?: ReadonlyArray<FakeClaudeStep>
  readonly error?: { readonly status: number | null; readonly message: string }
  /**
   * Holds each prompt's reply until `hang` is configured off; a Steer with priority `next` meanwhile
   * joins the held Turn and ends it, and an interrupt ends it stopped.
   */
  readonly hang?: boolean
  readonly replyDelayMillis?: number
  /** Holds Claude Code's start-up until `holdStart` is configured off. */
  readonly holdStart?: boolean
  readonly exit?: boolean
}

const LogLine = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("launched"),
      pid: Schema.Int,
      cwd: Schema.String,
    }),
    Schema.Struct({ kind: Schema.Literal("control"), request: Schema.Unknown }),
    Schema.Struct({ kind: Schema.Literal("replied") }),
    Schema.Struct({
      kind: Schema.Literal("permission"),
      toolName: Schema.String,
      answer: Schema.Unknown,
    }),
    Schema.Struct({
      kind: Schema.Literal("prompt"),
      prompt: Schema.String,
      images: Schema.Array(Schema.String),
      model: Schema.String,
      effort: Schema.NullOr(Schema.String),
    }),
  ]),
)

const decodeLine = Schema.decodeUnknownSync(LogLine)

type LogKind = (typeof LogLine.Type)["kind"]

export const fakeClaude = Effect.fnUntraced(function* (
  directory: string,
  initial: FakeClaudeSettings = {},
) {
  // The SDK runs a `.mjs` path through node; other paths it spawns directly, which Windows can't.
  const command = join(directory, "claude.mjs")

  const configure = (settings: FakeClaudeSettings) =>
    Effect.promise(async () => {
      const temporary = `${command}.json.next`
      await writeFile(temporary, JSON.stringify(settings))
      await rename(temporary, `${command}.json`)
    })

  yield* Effect.promise(async () => {
    await mkdir(directory, { recursive: true })
    // Resolves from this file and from `pnpm dev:fake`'s bundle in `dist-fake` alike.
    await copyFile(new URL("../test/fakeClaudeCli.mjs", import.meta.url), command)
    await writeFile(`${command}.log`, "")
  })
  yield* configure(initial)

  const log = Effect.promise(() => readFile(`${command}.log`, "utf8")).pipe(
    Effect.map((written) =>
      written
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => decodeLine(line)),
    ),
  )

  return {
    command,
    configure,
    log,
    logged: (kind: LogKind, count: number) =>
      eventually(
        log.pipe(
          Effect.filterOrFail(
            (lines) => lines.filter((line) => line.kind === kind).length >= count,
            () => new Error(`Claude Code logged fewer than ${count} "${kind}" lines`),
          ),
          Effect.asVoid,
        ),
      ),
  }
})
