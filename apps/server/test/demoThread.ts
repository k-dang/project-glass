import {
  GlassRpcs,
  type Image,
  type NewThread,
  type PullRequestRef,
  RPC_PATH,
  localPlace,
  TOKEN_PARAM,
} from "@glass/contracts"
import { Effect, Schema } from "effect"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { SUBMIT_REVIEW_TOOL } from "../src/agentHost/submitReviewTool"
import { GLASS_MCP_PREFIX } from "../src/agentHost/toolCalls"
import { connectRpcClient } from "../src/rpcSocket"
import { artifactsThread } from "./demoArtifacts"
import { syntheticReview } from "./demoAgentReview"
import { longThread } from "./demoLongThread"
import type { ScriptedThread } from "./demoScript"
import { DEMO_REPOSITORY, settledBranch, settledPullRequests } from "./demoPullRequests"
import { lastUserWords, replyTo, startFakeAnthropic } from "./fakeAnthropic"
import { globalChatReply, isGlobalChat } from "./fakeGlobalChat"
import {
  type FakeModelDelta,
  type FakeModelRequest,
  fakeModelProvider,
  lastUserText,
  commandFor,
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

const decodeToolArguments = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))

const glassToolReply = (input: FakeModelRequest): ReadonlyArray<FakeModelDelta> | undefined => {
  const calls = [...lastUserText(input).matchAll(/^call:(\S+) (.+)$/gm)]

  if (calls.length === 0) return undefined

  const asked = input.messages.findLastIndex(({ role }) => role === "user")
  const results = input.messages.slice(asked + 1).filter(({ role }) => role === "tool")
  const next = calls[results.length]

  if (next === undefined)
    return [
      {
        text: results
          .map((result) => `The fake model saw: ${textOf(result).slice(0, 200)}`)
          .join("\n\n"),
      },
    ]

  return [
    {
      toolCall: {
        id: `demo-glass-${input.messages.length}`,
        name: `${GLASS_MCP_PREFIX}${next[1]}`,
        arguments: decodeToolArguments(next[2]),
      },
    },
  ]
}

const reviewReply = (input: FakeModelRequest): ReadonlyArray<FakeModelDelta> | undefined => {
  const asked = lastUserText(input)

  if (!asked.startsWith("PR material")) return undefined

  if (input.messages.at(-1)?.role === "tool") return [{ text: "Handed in the Agent review." }]

  return [
    {
      toolCall: { id: "demo-review", name: SUBMIT_REVIEW_TOOL, arguments: syntheticReview(asked) },
    },
  ]
}

const scriptedThreads = [longThread, artifactsThread]

const demoReply = (input: FakeModelRequest): ReadonlyArray<FakeModelDelta> => {
  if (isGlobalChat(input)) return globalChatReply(input)

  const review = reviewReply(input)

  if (review !== undefined) return review

  const glassTool = glassToolReply(input)

  if (glassTool !== undefined) return glassTool

  for (const thread of scriptedThreads) {
    const scripted = thread.reply(input)

    if (scripted !== undefined) return scripted
  }

  const changes = {
    "Write a note": "printf 'hello from the agent\\n' > notes.txt",
    "Write another": "printf 'a second note\\n' > more.txt",
    "Pick up the README typo PR": "git switch -c fix-the-typo-in-the-readme",
    "Pick up the slow query PR": "git switch -c log-slow-database-queries",
    ...Object.fromEntries(
      settledPullRequests.map((pr) => [pr.title, `git switch -c ${settledBranch(pr)}`]),
    ),
  }

  if (commandFor(changes, input) !== undefined) return runCommands(changes)(input)
  const { messages } = input
  const last = messages.at(-1)

  if (last?.role === "tool")
    return [
      {
        text: "This is a **demo Thread**: the real pi CLI, answered by Glass's fake model provider.\n\nIt ran `ls -la` above, in its own worktree, and found:\n\n```text\nREADME.md\n```",
      },
    ]

  if (workingSlowly(input)) return slowReply.split(/(?<= )/).map((text) => ({ text }))

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

export const demoThreadNames = () => {
  const names = new Map<string, string>()

  return {
    branchFor: (request: string) => names.get(request),
    named: <A, E, R>(name: string, message: string, create: Effect.Effect<A, E, R>) =>
      Effect.sync(() => {
        names.set(message, name)
      }).pipe(Effect.andThen(create)),
  }
}

export const seedDemoThreads = Effect.fnUntraced(function* (
  port: number,
  token: string,
  checkout: string,
  reviewed: PullRequestRef,
  named: ReturnType<typeof demoThreadNames>["named"],
) {
  const client = yield* connectRpcClient(
    GlassRpcs,
    `ws://127.0.0.1:${port}${RPC_PATH}?${TOKEN_PARAM}=${token}`,
  )

  const linked = yield* client.LinkLocalCheckout({ path: checkout })

  const thread = (
    name: string,
    harness: NewThread["harness"],
    message: string,
    images: ReadonlyArray<Image> = [],
  ) =>
    named(
      name,
      message,
      client.CreateThread({
        repository: linked.repository,
        baseBranch: "main",
        harness,
        model: null,
        effort: null,
        permissionMode: harness === "claude-code" ? "default" : null,
        place: localPlace,
        message,
        images,
        skillPacks: [],
        localSkills: false,
      }),
    )

  const scripted = ({ name, images, opening, followUps }: ScriptedThread) =>
    thread(name, "pi", opening, images()).pipe(
      Effect.flatMap(({ id }) =>
        Effect.forEach(
          followUps,
          (message) => client.SendMessage({ threadId: id, message, images: [], feedback: [] }),
          { discard: true },
        ),
      ),
    )

  yield* thread("demo/look-around", "pi", "Show me around this repository.")
  yield* Effect.forEach(scriptedThreads, scripted, { discard: true })
  yield* thread("demo/uncommitted-note", "pi", "Write a note")
  yield* thread("demo/linked-pr", "pi", "Pick up the README typo PR")
  yield* Effect.forEach(
    settledPullRequests,
    (pr) => thread(`demo/${settledBranch(pr)}`, "pi", pr.title),
    { discard: true },
  )
  yield* thread("demo/keeps-working", "pi", keepWorkingPrompt)
  yield* thread("demo/claude-permission", "claude-code", "Run `pnpm test` and tell me what fails.")
  yield* thread(
    "demo/claude-question",
    "claude-code",
    "Ask me which part of the code to look at first.",
  )
  yield* thread("demo/claude-fails", "claude-code", `${failingPrompt} to its latest major version.`)

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
