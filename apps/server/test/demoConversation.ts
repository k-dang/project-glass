import {
  type Diagram,
  DRAW_DIAGRAM_TOOL,
  GlassRpcs,
  type NewConversation,
  type PullRequestRef,
  RPC_PATH,
  localPlace,
  TOKEN_PARAM,
} from "@glass/contracts"
import { Effect, Schema } from "effect"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { connectRpcClient } from "../src/rpcSocket"
import { DEMO_REPOSITORY } from "./demoPullRequests"
import { lastUserWords, replyTo, startFakeAnthropic } from "./fakeAnthropic"
import { globalConversationReply, isGlobalConversation } from "./fakeGlobalConversation"
import {
  type FakeModelDelta,
  type FakeModelRequest,
  fakeModelProvider,
  lastUserText,
  runCommands,
} from "./fakeModelProvider"
import { seedClone } from "./gitRepositories"
import { fakeAnthropicEnvironment, pinnedClaude } from "./pinnedClaude"
import { installedProgram } from "./replay"

const bundledPiPackage = new URL(
  "../node_modules/@earendil-works/pi-coding-agent/",
  import.meta.url,
)

export const bundledPi = fileURLToPath(new URL("dist/bundle/cli.js", bundledPiPackage))

export const bundledPiProgram = () =>
  installedProgram(fileURLToPath(new URL("package.json", bundledPiPackage)))

const textOf = (message: FakeModelRequest["messages"][number] | undefined) => {
  const content = message?.content

  return Schema.is(Schema.String)(content)
    ? content
    : (content ?? []).map((part) => part.text ?? "").join("")
}

const workingSlowly = ({ messages }: FakeModelRequest) => textOf(messages.at(-1)).includes("slowly")

const slowReply = `Working through it one step at a time. ${Array.from(
  { length: 12 },
  (_, step) => `Step ${step + 1} looks fine.`,
).join(" ")} All done.`

const diagramReply = [
  "Here's how a message reaches the Conversation:",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[Message box] --> B[Backend]",
  "  B --> C[Conversation]",
  "  C -->|streams reply| A",
  "```",
].join("\n")

const messageFlow = [
  "flowchart LR",
  "  A[Message box] --> B[Backend]",
  "  B --> C[Conversation]",
  "  C -->|streams reply| A",
]

const diagramDrawings = {
  "Diagram the message flow": {
    title: "Message flow",
    kind: "existing",
    mermaid: messageFlow.join("\n"),
  },
  "Add a queue to it": {
    title: "Message flow",
    kind: "proposed",
    mermaid: [...messageFlow, "  B --> Q[[Queue]]", "  Q --> C"].join("\n"),
  },
  "Break the diagram": {
    title: "Message flow",
    kind: "existing",
    mermaid: "flowchart LR\n  A -->> [[",
  },
} satisfies Record<string, Diagram>

const demoReply = (input: FakeModelRequest): ReadonlyArray<FakeModelDelta> => {
  if (isGlobalConversation(input)) return globalConversationReply(input)

  const changes = {
    "Write a note": "printf 'hello from the agent\\n' > notes.txt",
    "Write another": "printf 'a second note\\n' > more.txt",
  }

  if (Object.hasOwn(changes, lastUserText(input))) return runCommands(changes)(input)
  const { messages } = input
  const last = messages.at(-1)

  const drawing = Object.entries(diagramDrawings).find(
    ([words]) => words === lastUserText(input),
  )?.[1]

  if (drawing !== undefined)
    return last?.role === "tool"
      ? [{ text: "It's beside the conversation." }]
      : [
          {
            toolCall: {
              id: `demo-diagram-${messages.length}`,
              name: DRAW_DIAGRAM_TOOL,
              arguments: drawing,
            },
          },
        ]

  if (last?.role === "tool")
    return [
      {
        text: "This is a **demo Conversation**: the real pi CLI, answered by Glass's fake model provider.\n\nIt ran `ls -la` above, in its own worktree, and found:\n\n```text\nREADME.md\n```",
      },
    ]

  if (workingSlowly(input)) return slowReply.split(/(?<= )/).map((text) => ({ text }))

  if (lastUserText(input) === "Draw a diagram") return [{ text: diagramReply }]

  if (messages.some(({ role }) => role === "assistant"))
    return [{ text: `Got it: “${textOf(last)}”.` }]

  return [
    { thinking: "I'll look at what's in the repository first." },
    { toolCall: { id: "demo-ls", name: "bash", arguments: { command: "ls -la" } } },
  ]
}

const failingPrompt = "Upgrade every dependency"

export const startDemoClaude = Effect.fnUntraced(function* (directory: string) {
  const { url, respond } = yield* startFakeAnthropic
  yield* respond((request) =>
    lastUserWords(request).includes(failingPrompt)
      ? { type: "error", message: "The demo model refused this prompt." }
      : replyTo(request),
  )
  const environment = fakeAnthropicEnvironment(directory, url)
  Object.assign(process.env, environment)

  return pinnedClaude()
})

export const startDemoPi = Effect.fnUntraced(function* (directory: string) {
  yield* fakeModelProvider(directory, {
    reply: demoReply,
    chunkDelay: (input) => (workingSlowly(input) ? 300 : 0),
  })
  process.env["PI_CODING_AGENT_DIR"] = join(directory, ".pi", "agent")
})

export const demoCheckout = (repositories: string) => {
  const checkout = join(repositories, DEMO_REPOSITORY.repo)

  if (!existsSync(checkout)) seedClone(repositories, DEMO_REPOSITORY.owner, DEMO_REPOSITORY.repo)

  return checkout
}

export const seedDemoConversations = Effect.fnUntraced(function* (
  port: number,
  token: string,
  checkout: string,
  reviewed: PullRequestRef,
) {
  const client = yield* connectRpcClient(
    GlassRpcs,
    `ws://127.0.0.1:${port}${RPC_PATH}?${TOKEN_PARAM}=${token}`,
  )

  const linked = yield* client.LinkLocalCheckout({ path: checkout })

  const conversation = (harness: NewConversation["harness"], message: string) =>
    client.CreateConversation({
      repository: linked.repository,
      baseBranch: "main",
      harness,
      model: null,
      effort: null,
      permissionMode: harness === "claude-code" ? "default" : null,
      place: localPlace,
      message,
      images: [],
      skillPacks: [],
      localSkills: false,
    })

  yield* conversation("pi", "Show me around this repository.")
  yield* conversation("pi", "Write a note")
  yield* conversation("claude-code", "Run `pnpm test` and tell me what fails.")
  yield* conversation("claude-code", "Ask me which part of the code to look at first.")
  yield* conversation("claude-code", `${failingPrompt} to its latest major version.`)

  yield* client.SendGlobalMessage({
    message: "Ask me which PR to start with.",
    images: [],
    context: null,
  })

  yield* client.AddToQueue({ references: [reviewed] })
  const queued = yield* client.ListSavedQueue()

  const revision = queued.find(
    ({ pullRequest }) => pullRequest.ref.number === reviewed.number,
  )?.revision

  if (revision) yield* client.StartAgentReview({ pullRequest: reviewed, revision })
})
