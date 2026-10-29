import { GlassRpcs, RPC_PATH, thisMac, TOKEN_PARAM } from "@glass/contracts"
import { Effect, Option, Schema, Stream } from "effect"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { connectRpcClient } from "../src/rpcSocket"
import { DEMO_REPOSITORY } from "./demoPullRequests"
import type { FakeClaudeStep } from "./fakeClaude"
import { type FakeModelDelta, type FakeModelRequest, fakeModelProvider } from "./fakeModelProvider"
import { seedClone } from "./gitRepositories"

export const bundledPi = fileURLToPath(
  new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url),
)

const textOf = (message: FakeModelRequest["messages"][number] | undefined) => {
  const content = message?.content

  return Schema.is(Schema.String)(content)
    ? content
    : (content ?? []).map((part) => part.text ?? "").join("")
}

/** A message that asks the demo Agent to work "slowly" keeps its Turn running long enough to Queue, Steer, or Stop. */
const workingSlowly = ({ messages }: FakeModelRequest) => textOf(messages.at(-1)).includes("slowly")

const slowReply = `Working through it one step at a time. ${Array.from(
  { length: 12 },
  (_, step) => `Step ${step + 1} looks fine.`,
).join(" ")} All done.`

const demoReply = (input: FakeModelRequest): ReadonlyArray<FakeModelDelta> => {
  const { messages } = input
  const last = messages.at(-1)

  if (last?.role === "tool")
    return [
      {
        text: "This is a **demo Agent**: the real pi CLI, answered by Glass's fake model provider.\n\nIt ran `ls -la` above, in its own worktree, and found:\n\n```text\nREADME.md\n```",
      },
    ]

  if (workingSlowly(input)) return slowReply.split(/(?<= )/).map((text) => ({ text }))

  if (messages.some(({ role }) => role === "assistant"))
    return [{ text: `Got it: “${textOf(last)}”.` }]

  return [
    { thinking: "I'll look at what's in the repository first." },
    { toolCall: { id: "demo-ls", name: "bash", arguments: { command: "ls -la" } } },
  ]
}

export const demoClaudeReply: ReadonlyArray<FakeClaudeStep> = [
  { thinking: "A subagent can look around while I wait." },
  {
    toolCall: {
      id: "demo-task",
      name: "Agent",
      input: { description: "Look around the repository", prompt: "List the files." },
      output: "The repository holds a README.md.",
    },
  },
  {
    toolCall: {
      id: "demo-subagent-ls",
      name: "Bash",
      input: { command: "ls" },
      output: "README.md",
      parentToolCallId: "demo-task",
    },
  },
  {
    text: "This is a **demo Claude Code Agent** on `{model}` at `{effort}` effort: Glass's fake `claude`, answering without a model.",
  },
]

export const startDemoPi = Effect.fnUntraced(function* (directory: string) {
  yield* fakeModelProvider(directory, {
    reply: demoReply,
    chunkDelay: (input) => (workingSlowly(input) ? 300 : 0),
  })
  process.env["PI_CODING_AGENT_DIR"] = join(directory, ".pi", "agent")
})

export const seedDemoAgent = Effect.fnUntraced(function* (
  port: number,
  token: string,
  directory: string,
) {
  const client = yield* connectRpcClient(
    GlassRpcs,
    `ws://127.0.0.1:${port}${RPC_PATH}?${TOKEN_PARAM}=${token}`,
  )

  const agents = yield* client
    .WatchAgents()
    .pipe(Stream.runHead, Effect.map(Option.getOrElse(() => [])))

  if (agents.length > 0) return

  const checkout = join(directory, DEMO_REPOSITORY.repo)

  if (!existsSync(checkout)) seedClone(directory, DEMO_REPOSITORY.owner, DEMO_REPOSITORY.repo)

  const linked = yield* client.LinkLocalCheckout({ path: checkout })
  yield* client.CreateAgent({
    repository: linked.repository,
    baseBranch: "main",
    engine: "pi-cli",
    model: null,
    effort: null,
    permissionMode: null,
    place: thisMac,
    message: "Show me around this repository.",
    images: [],
  })
})
