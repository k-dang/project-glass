import { assert, describe, it } from "@effect/vitest"
import { GlobalChatCaller } from "./McpCredentials"
import {
  Thread,
  AgentReviewState,
  isWaiting,
  InboxItems,
  PullRequestRef,
  localPlace,
  SandboxPlace,
  TurnDone,
  type Turn,
} from "@glass/contracts"
import { Effect, Option, Predicate, Schema, Stream } from "effect"
import {
  glassCall,
  threadsFixture,
  glassCalls,
  holding,
  repository,
  settled,
} from "../../test/threadsFixture"
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
  const f = yield* threadsFixture

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

const decodeCreated = Schema.decodeUnknownSync(Schema.Struct({ thread: Thread }))

const decodeInboxItems = Schema.decodeUnknownSync(Schema.Struct({ items: InboxItems }))

const decodeStarted = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(StartedItem) }))

describe("Glass's Thread tools over MCP", () => {
  it.live("creates a Thread that appears in Threads and runs its first Turn", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

      const result = yield* f.call("create_thread", onThisDevice("Investigate the greeting"))

      assert.isFalse(result.isError, toolText(result))
      const { thread } = decodeCreated(result.structuredContent)
      assert.deepStrictEqual(
        (yield* f.threads).map(({ id }) => id),
        [thread.id],
      )

      const [turn] = yield* f.transcript(thread.id, settled(1))

      assert.equal(turn?.message, "Investigate the greeting")
      assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    }),
  )

  it.live("tells the Thread to link a Local checkout before a Thread on this device", () =>
    Effect.gen(function* () {
      const f = yield* startGlass

      const result = yield* f.call("create_thread", onThisDevice("Investigate"))

      assert.isTrue(result.isError)
      assert.include(toolText(result), "Link a Local checkout of glass-demo/greeter first.")
      assert.deepStrictEqual(yield* f.threads, [])
    }),
  )

  it.live("lists where a Thread can work and the choices each place offers", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

      const places = yield* f.call("list_thread_places")

      const options = yield* f.call("list_thread_options", {
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

  it.live("refuses a model or Effort the place doesn't offer, creating no Thread", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

      const model = yield* f.call("create_thread", {
        ...onThisDevice("Investigate"),
        model: "imagined",
      })

      const effort = yield* f.call("create_thread", {
        ...onThisDevice("Investigate"),
        model: "scripted",
        effort: "high",
      })

      assert.isTrue(model.isError)
      assert.include(toolText(model), "list_thread_options")
      assert.isTrue(effort.isError)
      assert.include(toolText(effort), "Effort")
      assert.deepStrictEqual(yield* f.threads, [])
    }),
  )

  it.live(
    "queues a message for a busy Thread and starts a Turn for an idle one, saying which",
    () =>
      Effect.gen(function* () {
        const f = yield* startGlass
        const thread = yield* f.start("hold:first")
        yield* f.transcript(thread.id, holding)

        const queued = yield* f.call("send_thread_message", {
          threadId: thread.id,
          message: "Next",
        })

        assert.deepStrictEqual(queued.structuredContent, { delivery: "queued" })
        yield* f.release("first")
        yield* f.transcript(thread.id, settled(2))

        const started = yield* f.call("send_thread_message", {
          threadId: thread.id,
          message: "Last",
        })

        assert.deepStrictEqual(started.structuredContent, { delivery: "started" })
        const turns = yield* f.transcript(thread.id, settled(3))
        assert.deepStrictEqual(
          turns.map(({ message }) => message),
          ["hold:first", "Next", "Last"],
        )
      }),
  )

  it.live(
    "lists a Thread it messaged as finished once stopped, though a message stays queued",
    () =>
      Effect.gen(function* () {
        const f = yield* startGlass
        const thread = yield* f.start("hold:first")
        yield* f.transcript(thread.id, holding)
        yield* f.call("send_thread_message", {
          threadId: thread.id,
          message: "Next",
        })

        yield* f.client.StopTurn({ threadId: thread.id })
        yield* f.transcript(thread.id, settled(1))

        const listed = yield* f.call("list_started_work")

        assert.deepStrictEqual(
          decodeStarted(listed.structuredContent).items.map(({ state }) => state),
          ["finished"],
        )
      }),
  )

  it.live("refuses a message while the Thread waits for the user's answer", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      const thread = yield* f.start("Please ask permission")
      yield* f.transcript(thread.id, (turns) => turns.some(({ parts }) => parts.some(isWaiting)))

      const result = yield* f.call("send_thread_message", {
        threadId: thread.id,
        message: "Next",
      })

      assert.isTrue(result.isError)
      assert.include(toolText(result), "waiting for the user")
    }),
  )

  it.live("lists what needs the user, as the Inbox shows it", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      const thread = yield* f.start("Please ask permission")

      const shown = yield* f.client.WatchInbox().pipe(
        Stream.filter((items) => items.some((item) => Predicate.isTagged(item, "Thread"))),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      )

      const result = yield* f.call("list_inbox")

      assert.isFalse(result.isError, toolText(result))
      const { items } = decodeInboxItems(result.structuredContent)
      assert.deepStrictEqual(items, shown)
      assert.deepStrictEqual(
        items.map((item) => Predicate.isTagged(item, "Thread") && item.thread.id),
        [thread.id],
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

  it.live("lists an Agent review the Thread started once it's written", () =>
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

const decodeResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Tuple([Schema.Struct({ text: Schema.String })])),
)

const calledBy = (turn: Turn | undefined) => {
  const [called] = glassCalls(turn) ?? []

  return { status: called?.status, text: decodeResult(called?.output)[0].text }
}

const callsIn = (turns: ReadonlyArray<Turn>) =>
  turns.filter(({ message }) => message.startsWith("call:"))

const callsSettled = (count: number) => (turns: ReadonlyArray<Turn>) =>
  callsIn(turns).length === count && turns.every(({ ended }) => ended !== null)

const createdIn = (turn: Turn | undefined) => decodeCreated(JSON.parse(calledBy(turn).text)).thread

describe("Glass's Thread tools called by a Thread", () => {
  it.live("tells a Thread in its own transcript once a Thread its agent created ends", () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture

      const parent = yield* f.start(glassCall("create_thread", onThisDevice("hold:child")))

      yield* f.transcript(parent.id, settled(1))
      const [child] = (yield* f.threads).filter(({ id }) => id !== parent.id)
      yield* f.transcript(child!.id, holding)
      yield* f.release("child")

      const [, update] = yield* f.transcript(parent.id, settled(2))
      yield* f.send(parent.id, glassCall("list_started_work", {}))
      const [, , listed] = yield* f.transcript(parent.id, settled(3))

      assert.deepStrictEqual<unknown>(
        Predicate.isTagged(update?.context, "StartedWorkUpdate") &&
          update.context.work.map((work) => [
            Predicate.isTagged(work, "Thread") && work.threadId,
            work.outcome,
          ]),
        [[child!.id, "finished"]],
      )
      assert.deepStrictEqual(
        decodeStarted(JSON.parse(calledBy(listed).text)).items.map(
          (item) => Predicate.isTagged(item, "Thread") && item.thread.id,
        ),
        [child!.id],
      )
    }),
  )

  it.live("gives a Thread it creates its own Permission mode, never one asking less", () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const claude = { ...onThisDevice("Investigate"), harness: "claude-code" }

      const parent = yield* f.start(glassCall("create_thread", claude), {
        harness: "claude-code",
        model: null,
        effort: null,
        permissionMode: "default",
      })

      yield* f.transcript(parent.id, callsSettled(1))
      yield* f.send(
        parent.id,
        glassCall("create_thread", {
          ...claude,
          place: SandboxPlace.make({ providerId: "fake" }),
        }),
      )
      yield* f.transcript(parent.id, callsSettled(2))
      yield* f.send(parent.id, glassCall("create_thread", onThisDevice("Investigate")))
      const [local, inSandbox, pi] = callsIn(yield* f.transcript(parent.id, callsSettled(3)))

      const refused = {
        status: "failed",
        text: "That Thread would ask the user less than you do, so you can't create it. Create one on this device with Claude Code instead, or ask the user to.",
      }

      assert.equal(createdIn(local).permissionMode, "default")
      assert.deepStrictEqual([calledBy(inSandbox), calledBy(pi)], [refused, refused])
      assert.equal((yield* f.threads).length, 2)
    }),
  )

  it.live("refuses a message to itself", () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const thread = yield* f.start("Say hello")
      yield* f.transcript(thread.id, settled(1))

      yield* f.send(
        thread.id,
        glassCall("send_thread_message", {
          threadId: thread.id,
          message: "Again",
        }),
      )
      const [, refused] = yield* f.transcript(thread.id, settled(2))

      assert.include(calledBy(refused).text, "can't send a message to itself")
    }),
  )

  it.live("a local Thread keeps Glass's tools after Glass relaunches", () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const thread = yield* f.start("hold:x")
      yield* f.transcript(thread.id, holding)

      yield* f.quit
      const relaunched = yield* f.launch
      yield* f.release("x")
      yield* f.transcript(thread.id, settled(1), relaunched)

      yield* relaunched.SendMessage({
        threadId: thread.id,
        message: glassCall("list_started_work", {}),
        images: [],
        feedback: [],
      })
      const [, listed] = yield* f.transcript(thread.id, settled(2), relaunched)

      assert.deepStrictEqual(calledBy(listed), {
        status: "done",
        text: JSON.stringify({ items: [] }),
      })
    }),
  )
})
