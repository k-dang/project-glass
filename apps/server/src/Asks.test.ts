import { assert, it } from "@effect/vitest"
import { type AskPlace, type Engine, PullRequestRef, Revision } from "@glass/contracts"
import { Effect, Fiber, Scope } from "effect"
import { existsSync } from "node:fs"
import { eventually } from "../test/eventually"
import { fakeAgent } from "../test/fakeAgent"
import { type FakeAgentSettings, piCliAnswer, piCliModels } from "../test/fakeAgentFiles"
import { startFakeGitHub } from "../test/fakeGitHub"
import { VIEWER } from "../test/fakePullRequest"
import { isolatedHome, startBackend } from "../test/harness"

const answered = (answer: string) => piCliAnswer(JSON.stringify({ answer }))

const fixture = Effect.fnUntraced(function* (
  settings: Partial<FakeAgentSettings> = {},
  timeout = 60_000,
  engine: Engine = "pi-cli",
) {
  const piCli = yield* fakeAgent({
    ready: true,
    output: answered("`main.ts` calls `greet` without a name.\n"),
    modelsOutput: piCliModels,
    ...settings,
  })

  const github = yield* startFakeGitHub({ git: true })
  const home = yield* isolatedHome

  const pr = github.seedPullRequest({
    title: "Greet people",
    body: "Use the person's name.",
    base: { sha: "b0", files: { "greet.ts": "hello\nbye\n", "main.ts": "greet()\n" } },
    head: { sha: "h1", files: { "greet.ts": "hi\nhello name\nbye\n", "main.ts": "greet()\n" } },
    changedFiles: [
      {
        path: "greet.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1,2 +1,3 @@\n-hello\n+hi\n+hello name\n bye",
      },
    ],
  })

  const scope = yield* Scope.make()
  yield* Effect.addFinalizer((exit) => Scope.close(scope, exit))

  const { client } = yield* startBackend(
    {
      GH_TOKEN: VIEWER.token,
      GLASS_GITHUB_API_URL: github.url,
      GLASS_GIT_REMOTE: github.gitUrl,
      GLASS_PI_COMMAND: piCli.command,
      GLASS_CLAUDE_COMMAND: piCli.command,
      GLASS_ASK_TIMEOUT_MS: String(timeout),
    },
    home,
  ).pipe(Effect.provideService(Scope.Scope, scope))

  const engineSettings = yield* client.GetEngineSettings({ feature: "agentReviews" })
  yield* client.SetEngineSettings({
    feature: "agentReviews",
    engineSettings: { ...engineSettings, engine },
  })

  const ref = new PullRequestRef({ owner: pr.owner, repo: pr.repo, number: pr.number })
  const revision = new Revision({ base: pr.base.sha, head: pr.head.sha })

  const ask = (place: AskPlace, question = "Who calls this?") =>
    client.Ask({ pullRequest: ref, revision, place, question })

  return { piCli, client, ask }
})

const helloName: AskPlace = { path: "greet.ts", side: "new", line: 2 }

it.live("answers from a read-only checkout, starting from the asked line", () =>
  Effect.gen(function* () {
    const f = yield* fixture()

    const result = yield* f.ask(helloName)

    assert.strictEqual(result.answer, "`main.ts` calls `greet` without a name.")
    assert.deepStrictEqual(result.runner, {
      engine: "pi-cli",
      model: "anthropic/claude-sonnet-5-5",
    })

    const prompted = (yield* f.piCli.calls).find((call) => call.stage === "prompted")!
    assert.deepStrictEqual(prompted.files, ["greet.ts", "main.ts"])
    assert.include(prompted.args.join(" "), "--tools read,grep,find,ls")
    assert.include(prompted.input, "Use the person's name.")
    assert.include(prompted.input, "+hello name")
    assert.include(prompted.input, '"text":"hello name"')
    assert.include(prompted.input, "Who calls this?")
    assert.isFalse(existsSync(prompted.cwd))
  }),
)

it.live("asks about a removed line on the base side", () =>
  Effect.gen(function* () {
    const f = yield* fixture()

    yield* f.ask({ path: "greet.ts", side: "old", line: 1 }, "Why did this go?")

    const prompted = (yield* f.piCli.calls).find((call) => call.stage === "prompted")!
    assert.include(prompted.input, '"side":"base","number":1,"text":"hello"')
  }),
)

it.live("refuses a line outside the diff without starting the agent", () =>
  Effect.gen(function* () {
    const f = yield* fixture()

    const failure = yield* f.ask({ path: "main.ts", side: "new", line: 1 }).pipe(Effect.flip)

    assert.strictEqual(failure.reason, "stale-revision")
    assert.isFalse((yield* f.piCli.calls).some((call) => call.stage === "generate"))
  }),
)

it.live("fails before starting an Agent review engine that can't read the checkout", () =>
  Effect.gen(function* () {
    const f = yield* fixture({}, undefined, "pi")

    const failure = yield* f.ask(helloName).pipe(Effect.flip)

    assert.strictEqual(failure.reason, "runner")
    assert.include(failure.message, "can't read the PR's code")
    assert.isEmpty(yield* f.piCli.calls)
  }),
)

it.live("fails as unusable when the agent returns a blank answer", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ output: answered(" \n") })

    const failure = yield* f.ask(helloName).pipe(Effect.flip)

    assert.strictEqual(failure.reason, "unusable-output")
  }),
)

it.live("fails as timed out when the agent passes its limit", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ hangAt: "generate" }, 500)

    const failure = yield* f.ask(helloName).pipe(Effect.flip)

    assert.strictEqual(failure.reason, "timeout")
  }),
)

it.live("interrupting a question stops the agent and removes its checkout", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ hangAt: "generate" }, 60_000)

    const asking = yield* Effect.forkChild(f.ask(helloName))
    yield* f.piCli.untilCalls("generate")
    const hung = (yield* f.piCli.calls).find((call) => call.stage === "generate")!
    assert.isTrue(existsSync(hung.cwd))

    yield* Fiber.interrupt(asking)

    yield* Effect.promise(() =>
      eventually(() => {
        assert.throws(() => process.kill(hung.pid, 0))
        assert.isFalse(existsSync(hung.cwd))
      }),
    )
  }),
)
