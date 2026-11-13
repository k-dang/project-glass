import { assert, describe, it } from "@effect/vitest"
import { PullRequestRef, Revision } from "@glass/contracts"
import { Effect, Schema } from "effect"
import { startFakeGitHub } from "../../test/fakeGitHub"
import { VIEWER } from "../../test/fakePullRequest"
import { isolatedHome, startBackend } from "../../test/harness"
import { connectMcp, listedTools, toolText } from "../../test/mcpClient"

const startGlass = Effect.gen(function* () {
  const github = yield* startFakeGitHub()

  const pr = github.seedPullRequest({
    owner: "acme",
    repo: "api",
    number: 42,
    title: "Greet by name",
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
    { GH_TOKEN: VIEWER.token, GLASS_GITHUB_API_URL: github.url },
    yield* isolatedHome,
  )

  const mcp = yield* connectMcp(
    backend.baseUrl,
    yield* backend.mcpCredentials.issue({ conversationId: "global-conversation" }),
  )

  return { ...backend, github, pr, mcp, call: mcp.call }
})

describe("Glass tools over MCP", () => {
  it.live("lists Glass's tools, marking which only read", () =>
    Effect.gen(function* () {
      const { mcp } = yield* startGlass

      const tools = listedTools(yield* mcp.request("tools/list", {}).response)

      assert.deepStrictEqual(
        tools.map(({ name, annotations }) => [name, annotations?.readOnlyHint]),
        [
          ["list_pull_requests", true],
          ["list_queue", true],
          ["list_to_dos", true],
          ["list_recent_activity", true],
          ["list_agents", true],
          ["list_needs_you", true],
          ["list_started_work", true],
          ["read_agent_transcript", true],
          ["read_pull_request", true],
          ["read_agent_review", true],
          ["start_agent_review", false],
          ["list_agent_places", true],
          ["list_agent_options", true],
          ["create_agent", false],
          ["send_agent_message", false],
          ["ask_user", false],
        ],
      )
    }),
  )

  it.live("reads the user's To-dos", () =>
    Effect.gen(function* () {
      const { client, call } = yield* startGlass
      yield* client.AddToDo({ title: "Reply to Sam" })

      const result = yield* call("list_to_dos")

      assert.deepStrictEqual(result.structuredContent, {
        toDos: [{ id: 1, title: "Reply to Sam", notes: "", done: false }],
      })
    }),
  )

  it.live("reads a PR at a Revision without recording an opening or changing the Queue", () =>
    Effect.gen(function* () {
      const { client, pr, call } = yield* startGlass
      const ref = new PullRequestRef(pr)
      yield* client.AddToQueue({ references: [ref] })
      const before = yield* client.ListActivity({ limit: 10 })

      const result = yield* call("read_pull_request", {
        pullRequest: { owner: "acme", repo: "api", number: 42 },
        revision: { base: "b0", head: "h1" },
      })

      assert.isFalse(result.isError)
      assert.include(toolText(result), "Greet by name")
      assert.include(toolText(result), "hello name")
      assert.deepStrictEqual(yield* client.ListActivity({ limit: 10 }), before)

      const [queued] = yield* client.ListSavedQueue()

      assert.isFalse(queued?.openedSinceQueued)
    }),
  )

  it.live("reads the PR as it is now when no Revision is given", () =>
    Effect.gen(function* () {
      const { pr, call } = yield* startGlass
      pr.push({ head: { sha: "h2", files: { "greet.ts": "hello again\n" } } })

      const result = yield* call("read_pull_request", {
        pullRequest: { owner: "acme", repo: "api", number: 42 },
      })

      assert.deepInclude(
        Schema.decodeUnknownSync(Schema.Struct({ revision: Revision }))(result.structuredContent),
        { revision: new Revision({ base: "b0", head: "h2" }) },
      )
    }),
  )

  it.live("explains a stale Revision as a tool failure", () =>
    Effect.gen(function* () {
      const { pr, call } = yield* startGlass
      pr.push({ head: { sha: "h2", files: {} } })

      const result = yield* call("read_pull_request", {
        pullRequest: { owner: "acme", repo: "api", number: 42 },
        revision: { base: "b0", head: "h1" },
      })

      assert.isTrue(result.isError)
      assert.include(toolText(result), "changed since that Revision")
    }),
  )

  it.live("explains an Agent that doesn't exist as a tool failure", () =>
    Effect.gen(function* () {
      const { call } = yield* startGlass

      const result = yield* call("read_agent_transcript", { agentId: "no-such-agent", turns: 3 })

      assert.isTrue(result.isError)
      assert.include(toolText(result), "no Agent with that id")
    }),
  )
})
