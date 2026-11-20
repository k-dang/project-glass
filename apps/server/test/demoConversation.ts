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
import { GLASS_MCP_PREFIX } from "../src/agentHost/toolCalls"
import { connectRpcClient } from "../src/rpcSocket"
import {
  LONG_CONVERSATION_FOLLOW_UPS,
  LONG_CONVERSATION_OPENING,
  longConversationReply,
} from "./demoLongConversation"
import { DEMO_REPOSITORY } from "./demoPullRequests"
import { lastUserWords, replyTo, startFakeAnthropic } from "./fakeAnthropic"
import { globalChatReply, isGlobalChat } from "./fakeGlobalChat"
import {
  type FakeModelDelta,
  type FakeModelRequest,
  fakeModelProvider,
  lastUserText,
  runCommands,
  textOf,
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

const workingSlowly = ({ messages }: FakeModelRequest) => textOf(messages.at(-1)).includes("slowly")

const keepWorkingPrompt = "Keep working until I stop you."

const keepsWorking = (input: FakeModelRequest) => lastUserText(input) === keepWorkingPrompt

const answersFollowUp = (input: FakeModelRequest) =>
  !isGlobalChat(input) &&
  input.messages.at(-1)?.role === "user" &&
  input.messages.some(({ role }) => role === "assistant")

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

const decodeToolArguments = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))

const glassToolReply = (input: FakeModelRequest): ReadonlyArray<FakeModelDelta> | undefined => {
  const called = /^call:(\S+) (.+)$/.exec(lastUserText(input))

  if (called === null) return undefined

  const last = input.messages.at(-1)

  if (last?.role === "tool") return [{ text: `The fake model saw: ${textOf(last).slice(0, 200)}` }]

  return [
    {
      toolCall: {
        id: `demo-glass-${input.messages.length}`,
        name: `${GLASS_MCP_PREFIX}${called[1]}`,
        arguments: decodeToolArguments(called[2]),
      },
    },
  ]
}

const demoReply = (input: FakeModelRequest): ReadonlyArray<FakeModelDelta> => {
  if (isGlobalChat(input)) return globalChatReply(input)

  const glassTool = glassToolReply(input)

  if (glassTool !== undefined) return glassTool

  const scripted = longConversationReply(input)

  if (scripted !== undefined) return scripted

  const changes = {
    "Write a note": "printf 'hello from the agent\\n' > notes.txt",
    "Write another": "printf 'a second note\\n' > more.txt",
    "Pick up the README typo PR": "git switch -c fix-the-typo-in-the-readme",
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

  if (answersFollowUp(input))
    return [
      { thinking: "Reading your reply." },
      ...`Got it: “${textOf(last)}”.`.split(/(?<= )/).map((text) => ({ text })),
    ]

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
    chunkDelay: (input) =>
      workingSlowly(input) || answersFollowUp(input) ? 300 : keepsWorking(input) ? 3_600_000 : 0,
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
  const long = yield* conversation("pi", LONG_CONVERSATION_OPENING)
  yield* Effect.forEach(
    LONG_CONVERSATION_FOLLOW_UPS,
    (message) => client.SendMessage({ conversationId: long.id, message, images: [], feedback: [] }),
    { discard: true },
  )
  yield* conversation("pi", "Write a note")
  yield* conversation("pi", "Pick up the README typo PR")
  yield* conversation("pi", keepWorkingPrompt)
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
