import {
  GlassRpcs,
  type NewAgent,
  type PullRequestRef,
  RPC_PATH,
  localPlace,
  TOKEN_PARAM,
} from "@glass/contracts"
import { Effect, Option, Schema, Stream } from "effect"
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

const demoReply = (input: FakeModelRequest): ReadonlyArray<FakeModelDelta> => {
  if (isGlobalConversation(input)) return globalConversationReply(input)

  const changes = {
    "Write a note": "printf 'hello from the Agent\\n' > notes.txt",
    "Write another": "printf 'a second note\\n' > more.txt",
  }

  if (Object.hasOwn(changes, lastUserText(input))) return runCommands(changes)(input)
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

/**
 * Seeds one of each kind of Agent work the Inbox lists: pi Agents that finish, Claude Code Agents
 * that wait on a Permission request or Question or whose Turn fails, a Question from the Global
 * conversation, and a finished Agent review of a queued PR.
 */
export const seedDemoAgents = Effect.fnUntraced(function* (
  port: number,
  token: string,
  directory: string,
  reviewed: PullRequestRef,
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

  const agent = (engine: NewAgent["engine"], message: string) =>
    client.CreateAgent({
      repository: linked.repository,
      baseBranch: "main",
      engine,
      model: null,
      effort: null,
      permissionMode: engine === "claude-code" ? "default" : null,
      place: localPlace,
      message,
      images: [],
      skillPacks: [],
      localSkills: false,
    })

  yield* agent("pi", "Show me around this repository.")
  yield* agent("pi", "Write a note")
  yield* agent("claude-code", "Run `pnpm test` and tell me what fails.")
  yield* agent("claude-code", "Ask me which part of the code to look at first.")
  yield* agent("claude-code", `${failingPrompt} to its latest major version.`)

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
