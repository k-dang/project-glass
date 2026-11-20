import { assert, describe, it } from "@effect/vitest"
import { ConversationCaller, GlobalChatCaller } from "./McpCredentials"
import {
  Conversation,
  AgentReviewState,
  isWaiting,
  NeedsYou,
  PullRequestRef,
  localPlace,
  SandboxPlace,
  TurnDone,
} from "@glass/contracts"
import { Effect, Option, Predicate, Schema, Stream } from "effect"
import { conversationsFixture, holding, repository, settled } from "../../test/conversationsFixture"
import { startFakeGitHub } from "../../test/fakeGitHub"
import { VIEWER } from "../../test/fakePullRequest"
import { isolatedHome, startBackend } from "../../test/harness"
import { connectMcp, toolText } from "../../test/mcpClient"
import { scriptedAgentRunners } from "../../test/scriptedAgentRunners"
import { StartedItem } from "../StartedWork"

const caller = GlobalChatCaller.make({
  globalChatId: "global-chat",
  sessionId: "global-session",
})

const startGlass = Effect.gen(function* () {
  const f = yield* conversationsFixture

  const { call } = yield* connectMcp(f.baseUrl, yield* f.mcpCredentials.issue(caller))

  return { ...f, call }
})

const onThisDevice = (message: string) => ({
  repository: { owner: repository.owner, repo: repository.repo },
  baseBranch: "main",
  place: localPlace,
  harness: "pi",
  model: null,
  effort: null,
  message,
})

const decodeCreated = Schema.decodeUnknownSync(Schema.Struct({ conversation: Conversation }))

const decodeNeedsYou = Schema.decodeUnknownSync(Schema.Struct({ items: NeedsYou }))

const decodeStarted = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(StartedItem) }))

describe("Glass's Conversation tools over MCP", () => {
  it.live("creates a Conversation that appears in Conversations and runs its first Turn", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

      const result = yield* f.call("create_conversation", onThisDevice("Investigate the greeting"))

      assert.isFalse(result.isError, toolText(result))
      const { conversation } = decodeCreated(result.structuredContent)
      assert.deepStrictEqual(
        (yield* f.conversations).map(({ id }) => id),
        [conversation.id],
      )

      const [turn] = yield* f.transcript(conversation.id, settled(1))

      assert.equal(turn?.message, "Investigate the greeting")
      assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    }),
  )

  it.live(
    "tells the conversation to link a Local checkout before a Conversation on this device",
    () =>
      Effect.gen(function* () {
        const f = yield* startGlass

        const result = yield* f.call("create_conversation", onThisDevice("Investigate"))

        assert.isTrue(result.isError)
        assert.include(toolText(result), "Link a Local checkout of glass-demo/greeter first.")
        assert.deepStrictEqual(yield* f.conversations, [])
      }),
  )

  it.live("lists where a Conversation can work and the choices each place offers", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

      const places = yield* f.call("list_conversation_places")

      const options = yield* f.call("list_conversation_options", {
        place: localPlace,
        repository: { owner: repository.owner, repo: repository.repo },
        harness: "pi",
      })

      assert.deepStrictEqual(places.structuredContent, {
        local: {
          harnesses: ["claude-code", "pi"],
          localCheckouts: [
            { repository: { owner: "glass-demo", repo: "greeter" }, path: f.clone.checkout },
          ],
        },
        sandboxProviders: [
          { id: "fake", name: "Fake Sandboxes", harnesses: ["claude-code", "pi"] },
        ],
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

  it.live("refuses a model or Effort the place doesn't offer, creating no Conversation", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

      const model = yield* f.call("create_conversation", {
        ...onThisDevice("Investigate"),
        model: "imagined",
      })

      const effort = yield* f.call("create_conversation", {
        ...onThisDevice("Investigate"),
        model: "scripted",
        effort: "high",
      })

      assert.isTrue(model.isError)
      assert.include(toolText(model), "list_conversation_options")
      assert.isTrue(effort.isError)
      assert.include(toolText(effort), "Effort")
      assert.deepStrictEqual(yield* f.conversations, [])
    }),
  )

  it.live(
    "queues a message for a busy Conversation and starts a Turn for an idle one, saying which",
    () =>
      Effect.gen(function* () {
        const f = yield* startGlass
        const conversation = yield* f.start("hold:first")
        yield* f.transcript(conversation.id, holding)

        const queued = yield* f.call("send_conversation_message", {
          conversationId: conversation.id,
          message: "Next",
        })

        assert.deepStrictEqual(queued.structuredContent, { delivery: "queued" })
        yield* f.release("first")
        yield* f.transcript(conversation.id, settled(2))

        const started = yield* f.call("send_conversation_message", {
          conversationId: conversation.id,
          message: "Last",
        })

        assert.deepStrictEqual(started.structuredContent, { delivery: "started" })
        const turns = yield* f.transcript(conversation.id, settled(3))
        assert.deepStrictEqual(
          turns.map(({ message }) => message),
          ["hold:first", "Next", "Last"],
        )
      }),
  )

  it.live(
    "lists a Conversation it messaged as finished once stopped, though a message stays queued",
    () =>
      Effect.gen(function* () {
        const f = yield* startGlass
        const conversation = yield* f.start("hold:first")
        yield* f.transcript(conversation.id, holding)
        yield* f.call("send_conversation_message", {
          conversationId: conversation.id,
          message: "Next",
        })

        yield* f.client.StopTurn({ conversationId: conversation.id })
        yield* f.transcript(conversation.id, settled(1))

        const listed = yield* f.call("list_started_work")

        assert.deepStrictEqual(
          decodeStarted(listed.structuredContent).items.map(({ state }) => state),
          ["finished"],
        )
      }),
  )

  it.live("refuses a message while the Conversation waits for the user's answer", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      const conversation = yield* f.start("Please ask permission")
      yield* f.transcript(conversation.id, (turns) =>
        turns.some(({ parts }) => parts.some(isWaiting)),
      )

      const result = yield* f.call("send_conversation_message", {
        conversationId: conversation.id,
        message: "Next",
      })

      assert.isTrue(result.isError)
      assert.include(toolText(result), "waiting for the user")
    }),
  )

  it.live("lists what needs the user, as Needs you shows it", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      const conversation = yield* f.start("Please ask permission")

      const shown = yield* f.client.WatchNeedsYou().pipe(
        Stream.filter((items) => items.some((item) => Predicate.isTagged(item, "Conversation"))),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      )

      const result = yield* f.call("list_needs_you")

      assert.isFalse(result.isError, toolText(result))
      const { items } = decodeNeedsYou(result.structuredContent)
      assert.deepStrictEqual(items, shown)
      assert.deepStrictEqual(
        items.map((item) => Predicate.isTagged(item, "Conversation") && item.conversation.id),
        [conversation.id],
      )
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

const decodeReview = Schema.decodeUnknownSync(AgentReviewState)

describe("Glass's Agent review tools over MCP", () => {
  it.live("starts an Agent review, then reads it once written", () =>
    Effect.gen(function* () {
      const f = yield* startReviewing

      const started = yield* f.call("start_agent_review", {
        pullRequest: f.pullRequest,
        revision: f.revision,
      })

      assert.isFalse(started.isError, toolText(started))
      assert.equal(decodeReview(started.structuredContent).job.status, "reviewing")
      yield* f.review(({ review }) => review !== null)

      const read = yield* f.call("read_agent_review", { pullRequest: f.pullRequest })

      const { review, job } = decodeReview(read.structuredContent)
      assert.equal(job.status, "idle")
      assert.equal(review?.markdown, markdown)
      assert.equal(review?.revision.head, f.revision.head)
    }),
  )

  it.live("lists an Agent review the conversation started once it's written", () =>
    Effect.gen(function* () {
      const f = yield* startReviewing

      yield* f.call("start_agent_review", { pullRequest: f.pullRequest, revision: f.revision })
      yield* f.review(({ review }) => review !== null)

      const listed = yield* f.call("list_started_work")

      assert.deepStrictEqual(
        decodeStarted(listed.structuredContent).items.map((item) => [
          Predicate.isTagged(item, "AgentReview") && item.pullRequest,
          item.state,
        ]),
        [[new PullRequestRef(f.pullRequest), "finished"]],
      )
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

const asConversation = (f: Effect.Success<typeof conversationsFixture>, conversationId: string) =>
  f.mcpCredentials
    .issue(ConversationCaller.make({ conversationId }))
    .pipe(Effect.flatMap((bearer) => connectMcp(f.baseUrl, bearer)))

describe("Glass's Conversation tools called by a Conversation", () => {
  it.live(
    "tells a Conversation in its own transcript once a Conversation its agent created ends",
    () =>
      Effect.gen(function* () {
        const f = yield* conversationsFixture

        const parent = yield* f.start(
          `call:create_conversation ${JSON.stringify(onThisDevice("hold:child"))}`,
        )

        yield* f.transcript(parent.id, settled(1))
        const [child] = (yield* f.conversations).filter(({ id }) => id !== parent.id)
        yield* f.transcript(child!.id, holding)
        yield* f.release("child")

        const [, update] = yield* f.transcript(parent.id, settled(2))
        const { call } = yield* asConversation(f, parent.id)

        assert.deepStrictEqual<unknown>(
          Predicate.isTagged(update?.context, "StartedWorkUpdate") &&
            update.context.work.map((work) => [
              Predicate.isTagged(work, "Conversation") && work.conversationId,
              work.outcome,
            ]),
          [[child!.id, "finished"]],
        )
        assert.deepStrictEqual(
          decodeStarted((yield* call("list_started_work")).structuredContent).items.map(
            (item) => Predicate.isTagged(item, "Conversation") && item.conversation.id,
          ),
          [child!.id],
        )
      }),
  )

  it.live("gives a Conversation it creates its own Permission mode, never one asking less", () =>
    Effect.gen(function* () {
      const f = yield* conversationsFixture

      const parent = yield* f.start("Say hello", {
        harness: "claude-code",
        model: null,
        effort: null,
        permissionMode: "default",
      })

      const { call } = yield* asConversation(f, parent.id)
      const claude = { ...onThisDevice("Investigate"), harness: "claude-code" }

      const local = yield* call("create_conversation", claude)

      const inSandbox = yield* call("create_conversation", {
        ...claude,
        place: SandboxPlace.make({ providerId: "fake" }),
      })

      const pi = yield* call("create_conversation", onThisDevice("Investigate"))

      assert.equal(decodeCreated(local.structuredContent).conversation.permissionMode, "default")

      const refusal =
        "That Conversation would ask the user less than you do, so you can't create it. Create one on this device with Claude Code instead, or ask the user to."

      assert.deepStrictEqual(
        [inSandbox, pi].map((refused) => [refused.isError, toolText(refused)]),
        [
          [true, refusal],
          [true, refusal],
        ],
      )
      assert.equal((yield* f.conversations).length, 2)
    }),
  )

  it.live("refuses a message to itself", () =>
    Effect.gen(function* () {
      const f = yield* conversationsFixture
      const conversation = yield* f.start("Say hello")
      yield* f.transcript(conversation.id, settled(1))
      const { call } = yield* asConversation(f, conversation.id)

      const result = yield* call("send_conversation_message", {
        conversationId: conversation.id,
        message: "Again",
      })

      assert.include(toolText(result), "can't send a message to itself")
    }),
  )
})
