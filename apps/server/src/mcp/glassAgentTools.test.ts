import { assert, describe, it } from "@effect/vitest"
import {
  Agent,
  type AgentReviewState,
  AgentReviewState as AgentReviewStateSchema,
  isWaiting,
  PullRequestRef,
  localPlace,
  TurnDone,
} from "@glass/contracts"
import { Effect, Option, Schema, Stream } from "effect"
import { agentsFixture, holding, repository, settled } from "../../test/agentsFixture"
import { startFakeGitHub } from "../../test/fakeGitHub"
import { VIEWER } from "../../test/fakePullRequest"
import { isolatedHome, startBackend } from "../../test/harness"
import { connectMcp, toolText as textOf } from "../../test/mcpClient"
import { scriptedAgentRunners } from "../../test/scriptedAgentRunners"

const caller = { conversationId: "global-conversation" }

const startGlass = Effect.gen(function* () {
  const f = yield* agentsFixture

  const { call } = yield* connectMcp(f.baseUrl, yield* f.mcpCredentials.issue(caller))

  return { ...f, call }
})

const onThisDevice = (message: string) => ({
  repository: { owner: repository.owner, repo: repository.repo },
  baseBranch: "main",
  place: localPlace,
  engine: "pi",
  model: null,
  effort: null,
  message,
})

const decodeCreated = Schema.decodeUnknownSync(Schema.Struct({ agent: Agent }))

describe("Glass's Agent tools over MCP", () => {
  it.live("creates an Agent that appears in Agents and runs its first Turn", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

      const result = yield* f.call("create_agent", onThisDevice("Investigate the greeting"))

      assert.isFalse(result.isError, textOf(result))
      const { agent } = decodeCreated(result.structuredContent)
      assert.deepStrictEqual(
        (yield* f.agents).map(({ id }) => id),
        [agent.id],
      )

      const [turn] = yield* f.transcript(agent.id, settled(1))

      assert.equal(turn?.message, "Investigate the greeting")
      assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    }),
  )

  it.live("tells the conversation to link a Local checkout before an Agent on this device", () =>
    Effect.gen(function* () {
      const f = yield* startGlass

      const result = yield* f.call("create_agent", onThisDevice("Investigate"))

      assert.isTrue(result.isError)
      assert.include(textOf(result), "Link a Local checkout of glass-demo/greeter first.")
      assert.deepStrictEqual(yield* f.agents, [])
    }),
  )

  it.live("lists where an Agent can work and the choices each place offers", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

      const places = yield* f.call("list_agent_places")

      const options = yield* f.call("list_agent_options", {
        place: localPlace,
        repository: { owner: repository.owner, repo: repository.repo },
        engine: "pi",
      })

      assert.deepStrictEqual(places.structuredContent, {
        local: {
          engines: ["claude-code", "pi"],
          localCheckouts: [
            { repository: { owner: "glass-demo", repo: "greeter" }, path: f.clone.checkout },
          ],
        },
        sandboxProviders: [{ id: "fake", name: "Fake Sandboxes", engines: ["claude-code", "pi"] }],
        followedRepositories: [],
      })
      assert.deepStrictEqual(options.structuredContent, {
        defaultBranch: "main",
        branches: ["develop", "main"],
        models: {
          defaultModel: null,
          models: [{ id: "scripted", name: "Scripted", efforts: [] }],
        },
      })
    }),
  )

  it.live("refuses a model or Effort the place doesn't offer, creating no Agent", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

      const model = yield* f.call("create_agent", {
        ...onThisDevice("Investigate"),
        model: "imagined",
      })

      const effort = yield* f.call("create_agent", {
        ...onThisDevice("Investigate"),
        model: "scripted",
        effort: "high",
      })

      assert.isTrue(model.isError)
      assert.include(textOf(model), "list_agent_options")
      assert.isTrue(effort.isError)
      assert.include(textOf(effort), "Effort")
      assert.deepStrictEqual(yield* f.agents, [])
    }),
  )

  it.live("queues a message for a busy Agent and starts a Turn for an idle one, saying which", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      const agent = yield* f.start("hold:first")
      yield* f.transcript(agent.id, holding)

      const queued = yield* f.call("send_agent_message", { agentId: agent.id, message: "Next" })

      assert.deepStrictEqual(queued.structuredContent, { delivery: "queued" })
      yield* f.release("first")
      yield* f.transcript(agent.id, settled(2))

      const started = yield* f.call("send_agent_message", { agentId: agent.id, message: "Last" })

      assert.deepStrictEqual(started.structuredContent, { delivery: "started" })
      const turns = yield* f.transcript(agent.id, settled(3))
      assert.deepStrictEqual(
        turns.map(({ message }) => message),
        ["hold:first", "Next", "Last"],
      )
    }),
  )

  it.live("refuses a message while the Agent waits for the user's answer", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      const agent = yield* f.start("Please ask permission")
      yield* f.transcript(agent.id, (turns) => turns.some(({ parts }) => parts.some(isWaiting)))

      const result = yield* f.call("send_agent_message", { agentId: agent.id, message: "Next" })

      assert.isTrue(result.isError)
      assert.include(textOf(result), "waiting for the user")
    }),
  )
})

const markdown = "**The greeting takes a name.** Nothing blocks it."

const startReviewing = Effect.gen(function* () {
  const runners = yield* scriptedAgentRunners({ reply: { answer: { markdown } } })
  const github = yield* startFakeGitHub({ git: true })

  const pr = github.seedPullRequest({
    base: { sha: "b0", files: { "greet.ts": "hi\n" } },
    head: { sha: "h1", files: { "greet.ts": "hello name\n" } },
    changedFiles: [
      {
        path: "greet.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-hi\n+hello name",
      },
    ],
  })

  const backend = yield* startBackend(
    { GH_TOKEN: VIEWER.token, GLASS_GITHUB_API_URL: github.url, GLASS_GIT_REMOTE: github.gitUrl },
    yield* isolatedHome,
    runners.layer,
  )

  const { call } = yield* connectMcp(backend.baseUrl, yield* backend.mcpCredentials.issue(caller))
  const pullRequest = { owner: pr.owner, repo: pr.repo, number: pr.number }

  const review = (until: (state: AgentReviewState) => boolean) =>
    backend.client
      .WatchAgentReview({ pullRequest: new PullRequestRef(pullRequest) })
      .pipe(Stream.filter(until), Stream.runHead, Effect.map(Option.getOrThrow))

  const revision = { base: pr.base.sha, head: pr.head.sha }

  return { ...backend, pr, pullRequest, revision, call, review }
})

const decodeReview = Schema.decodeUnknownSync(AgentReviewStateSchema)

describe("Glass's Agent review tools over MCP", () => {
  it.live("starts an Agent review, then reads it once written", () =>
    Effect.gen(function* () {
      const f = yield* startReviewing

      const started = yield* f.call("start_agent_review", {
        pullRequest: f.pullRequest,
        revision: f.revision,
      })

      assert.isFalse(started.isError, textOf(started))
      assert.equal(decodeReview(started.structuredContent).job.status, "reviewing")
      yield* f.review(({ review }) => review !== null)

      const read = yield* f.call("read_agent_review", { pullRequest: f.pullRequest })

      const { review, job } = decodeReview(read.structuredContent)
      assert.equal(job.status, "idle")
      assert.equal(review?.markdown, markdown)
      assert.equal(review?.revision.head, f.revision.head)
    }),
  )

  it.live("reads why an Agent review of a stale Revision failed", () =>
    Effect.gen(function* () {
      const f = yield* startReviewing
      const { revision } = f
      f.pr.push({ head: { sha: "h2", files: { "greet.ts": "hello again\n" } } })

      yield* f.call("start_agent_review", { pullRequest: f.pullRequest, revision })
      yield* f.review(({ job }) => job.status === "failed")

      const { job } = decodeReview(
        (yield* f.call("read_agent_review", { pullRequest: f.pullRequest })).structuredContent,
      )

      assert.equal(job.status === "failed" && job.reason.reason, "stale-revision")
    }),
  )
})
