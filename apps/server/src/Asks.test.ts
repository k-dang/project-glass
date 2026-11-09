import { assert, it } from "@effect/vitest"
import { type AskPlace, PullRequestRef, Revision } from "@glass/contracts"
import { Clock, Effect, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { existsSync } from "node:fs"
import { eventually } from "../test/eventually"
import { startFakeGitHub } from "../test/fakeGitHub"
import { VIEWER } from "../test/fakePullRequest"
import { watchDeadlines } from "../test/deadlines"
import { isolatedHome, startBackend } from "../test/harness"
import { type ScriptedSettings, scriptedAgentRunners } from "../test/scriptedAgentRunners"
import { Deadlines } from "./ServerConfig"

const deadline = 60_000

const fixture = Effect.fnUntraced(function* (
  settings: ScriptedSettings = {
    reply: { answer: { answer: "`main.ts` calls `greet` without a name.\n" } },
  },
) {
  const runners = yield* scriptedAgentRunners(settings)
  const github = yield* startFakeGitHub({ git: true })
  const home = yield* isolatedHome
  const { watched, deadlineSet } = yield* watchDeadlines(deadline)

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
    },
    home,
    runners.layer,
  ).pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.provideService(Clock.Clock, watched),
    Effect.updateService(Deadlines, (deadlines) => ({ ...deadlines, askMs: deadline })),
  )

  const ref = new PullRequestRef({ owner: pr.owner, repo: pr.repo, number: pr.number })
  const revision = new Revision({ base: pr.base.sha, head: pr.head.sha })

  const ask = (place: AskPlace, question = "Who calls this?") =>
    client.Ask({ pullRequest: ref, revision, place, question })

  return { runners, ask, deadlineSet }
})

const helloName: AskPlace = { path: "greet.ts", side: "new", line: 2 }

it.live("answers from a read-only checkout, starting from the asked line", () =>
  Effect.gen(function* () {
    const f = yield* fixture()

    const result = yield* f.ask(helloName)

    assert.strictEqual(result.answer, "`main.ts` calls `greet` without a name.")
    assert.deepStrictEqual(result.runner, { engine: "pi", model: "anthropic/claude-sonnet-5-5" })

    const [run] = f.runners.runs
    assert.deepStrictEqual(run?.files, ["greet.ts", "main.ts"])
    assert.include(run?.task.prompt, "Use the person's name.")
    assert.include(run?.task.prompt, "+hello name")
    assert.include(run?.task.prompt, '"text":"hello name"')
    assert.include(run?.task.prompt, "Who calls this?")
    assert.isFalse(existsSync(run!.task.checkout))
  }),
)

it.live("asks about a removed line on the base side", () =>
  Effect.gen(function* () {
    const f = yield* fixture()

    yield* f.ask({ path: "greet.ts", side: "old", line: 1 }, "Why did this go?")

    assert.include(f.runners.runs[0]?.task.prompt, '"side":"base","number":1,"text":"hello"')
  }),
)

it.live("refuses a line outside the diff without starting the agent", () =>
  Effect.gen(function* () {
    const f = yield* fixture()

    const failure = yield* f.ask({ path: "main.ts", side: "new", line: 1 }).pipe(Effect.flip)

    assert.strictEqual(failure.reason, "stale-revision")
    assert.isEmpty(f.runners.runs)
  }),
)

it.live("fails as unusable when the agent returns a blank answer", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ reply: { answer: { answer: " \n" } } })

    const failure = yield* f.ask(helloName).pipe(Effect.flip)

    assert.strictEqual(failure.reason, "unusable-output")
  }),
)

it.effect("fails as timed out when the agent passes its limit", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ reply: "hold" })

    const asking = yield* Effect.forkChild(f.ask(helloName).pipe(Effect.flip))
    yield* f.runners.ran(1)
    yield* f.deadlineSet
    yield* TestClock.adjust(deadline)
    const failure = yield* Fiber.join(asking)

    assert.strictEqual(failure.reason, "timeout")
  }),
)

it.live("interrupting a question stops the agent and removes its checkout", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ reply: "hold" })

    const asking = yield* Effect.forkChild(f.ask(helloName))
    yield* f.runners.ran(1)
    const checkout = f.runners.runs[0]!.task.checkout
    assert.isTrue(existsSync(checkout))

    yield* Fiber.interrupt(asking)

    yield* f.runners.interrupted(1)
    yield* eventually(Effect.sync(() => assert.isFalse(existsSync(checkout))))
  }),
)
