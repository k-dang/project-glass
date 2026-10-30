import { assert, it } from "@effect/vitest"
import { PullRequestRef, Revision, type Engine, type TourState } from "@glass/contracts"
import { Effect, Exit, Fiber, Option, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { existsSync } from "node:fs"
import { readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { eventually } from "../test/eventually"
import { fakeAgent } from "../test/fakeAgent"
import { fakeModelProvider } from "../test/fakeModelProvider"
import { piCredentialHelper, type RunningHelper } from "../test/piCredentialHelper"
import { tourInstructions } from "./tourPrompt"
import { claudeAnswer, type FakeAgentSettings, piCliOutput } from "../test/fakeAgentFiles"
import { startFakeGitHub } from "../test/fakeGitHub"
import { VIEWER } from "../test/fakePullRequest"
import { isolatedHome, startBackend } from "../test/harness"

const answer = {
  intent: "Greet people by name.",
  chapters: [
    {
      title: "Name the greeting",
      explanation: "Use the supplied name.",
      files: [{ path: "greet.ts", summary: "Builds the greeting." }],
    },
  ],
  unplacedFiles: [],
}

// `pi --list-models` prints a table; its search is fuzzy, so near misses appear too.
const piCliModels = [
  "provider   model                 context",
  "anthropic  claude-sonnet-5-5     1M",
  "litellm    deepseek-test-2       1M",
  "litellm    deepseek-test         1M",
].join("\n")

const deadline = 60_000

const fixture = Effect.fnUntraced(function* (
  settings?: Partial<FakeAgentSettings>,
  timeout = deadline,
) {
  const agent = yield* fakeAgent({
    ready: true,
    output: claudeAnswer(answer),
    ...settings,
  })

  const piCli = yield* fakeAgent({ ready: true, output: "", modelsOutput: piCliModels })
  const github = yield* startFakeGitHub()
  const home = yield* isolatedHome

  const pr = github.seedPullRequest({
    title: "Greet people",
    body: "Use the person's name.",
    base: { sha: "b0", files: { "greet.ts": "hello" } },
    head: {
      sha: "h1",
      files: { "greet.ts": "hello name", "README.md": "greeting", "logo.png": "\0binary" },
    },
    changedFiles: [
      {
        path: "greet.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-hello\n+hello name",
      },
      { path: "README.md", status: "added" },
      { path: "logo.png", status: "added" },
    ],
  })

  const ref = new PullRequestRef({ owner: pr.owner, repo: pr.repo, number: pr.number })
  const revision = new Revision({ base: "b0", head: "h1" })

  const env = {
    GH_TOKEN: VIEWER.token,
    GLASS_GITHUB_API_URL: github.url,
    GLASS_CLAUDE_COMMAND: agent.command,
    GLASS_PI_COMMAND: piCli.command,
    GLASS_TOUR_TIMEOUT_MS: String(timeout),
  }

  const serverScope = yield* Scope.make()
  yield* Effect.addFinalizer((exit) => Scope.close(serverScope, exit))

  const { client } = yield* startBackend(env, home).pipe(
    Effect.provideService(Scope.Scope, serverScope),
  )

  const state = (predicate: (state: TourState) => boolean) =>
    client
      .WatchTour({ pullRequest: ref })
      .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow))

  return {
    agent,
    piCli,
    github,
    home,
    pr,
    ref,
    revision,
    env,
    client,
    state,
    restart: Effect.gen(function* () {
      yield* Scope.close(serverScope, Exit.void)
      const restarted = yield* startBackend(env, home)

      return yield* restarted.client
        .WatchTour({ pullRequest: ref })
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow))
    }),
    write: client.WriteTour({ pullRequest: ref, revision }),
    useEngine: (engine: Engine) =>
      client
        .GetEngineSettings({ feature: "tours" })
        .pipe(
          Effect.flatMap((current) =>
            client.SetEngineSettings({ feature: "tours", engineSettings: { ...current, engine } }),
          ),
        ),
  }
})

const completed = (state: TourState) => state.job.status !== "writing"

it.live(
  "cancels an agent process and keeps a saved Tour after a failed replacement and restart",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.write
      const saved = yield* f.state((state) => state.tour !== null)
      yield* f.agent.configure({ ready: true, output: "", hangAt: "generate" })
      yield* f.write
      yield* f.state((state) => state.job.status === "writing" && state.job.runner !== null)
      yield* f.agent.untilCalls("generate", 2)
      const calls = yield* f.agent.calls
      const processCall = calls.filter((entry) => entry.stage === "generate").at(-1)!
      yield* f.client.CancelTour({ pullRequest: f.ref })
      assert.deepStrictEqual((yield* f.state(completed)).tour, saved.tour)
      assert.throws(() => process.kill(processCall.pid, 0))
      assert.isFalse(existsSync(processCall.cwd))
      yield* f.agent.configure({ ready: true, output: "not JSON" })
      yield* f.write
      const failed = yield* f.state(completed)
      assert.deepStrictEqual(failed.tour, saved.tour)
      assert.equal(failed.job.status, "failed")
      const restored = yield* f.restart

      assert.deepStrictEqual(restored, { tour: saved.tour, job: { status: "idle" } })
    }),
)

it.live(
  "repairs invented, duplicate, omitted, and unplaced paths without rejecting coverage mistakes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        output: claudeAnswer({
          intent: "Cover every file.",
          chapters: [
            {
              title: "Greeting",
              explanation: "Changes behavior.",
              files: [
                { path: "greet.ts", summary: "First placement." },
                { path: "invented.ts", summary: "Drop this." },
              ],
            },
            {
              title: "Duplicate",
              explanation: "",
              files: [{ path: "greet.ts", summary: "Drop duplicate." }],
            },
            { title: "Context", explanation: "Keep this explanation.", files: [] },
          ],
          unplacedFiles: ["logo.png", "logo.png", "invented.ts", "greet.ts"],
        }),
      })

      yield* f.write
      const state = yield* f.state(completed)
      assert.deepStrictEqual(
        state.tour?.chapters.map((chapter) => [
          chapter.title,
          chapter.files.map((file) => file.path),
        ]),
        [
          ["Greeting", ["greet.ts"]],
          ["Context", []],
        ],
      )
      assert.deepStrictEqual(state.tour?.everythingElse, ["logo.png", "README.md"])
      const log = yield* f.agent.log
      assert.include(log, "Use the person's name.")
      assert.include(log, "logo.png")
    }),
)

for (const [name, settings, expected] of [
  ["invalid answer shape", { output: claudeAnswer({ chapters: "wrong" }) }, "unusable-output"],
  [
    "no surviving Chapters",
    { output: claudeAnswer({ ...answer, chapters: [] }) },
    "unusable-output",
  ],
  [
    "unsuccessful exit",
    { exitCode: 1, stderr: "provider unavailable; secret-should-not-leak" },
    "runner",
  ],
  [
    "authentication rejection",
    { exitCode: 1, stderr: "401 unauthorized secret-should-not-leak" },
    "authentication",
  ],
  [
    "authentication rejection in JSON stdout",
    {
      exitCode: 1,
      output: JSON.stringify({ is_error: true, result: "401 unauthorized secret-should-not-leak" }),
    },
    "authentication",
  ],
  [
    "authentication error envelope with a successful exit",
    {
      output: JSON.stringify({ is_error: true, result: "Invalid API key secret-should-not-leak" }),
    },
    "authentication",
  ],
  ["not signed in", { ready: false }, "not-ready"],
  ["slow generation", { hangAt: "generate" }, "timeout"],
  ["slow readiness check", { hangAt: "auth" }, "timeout"],
] as const) {
  it.effect(`reports ${name} without leaking CLI output`, () =>
    Effect.gen(function* () {
      const f = yield* fixture(settings)
      yield* f.write

      if ("hangAt" in settings) {
        yield* f.agent.untilCalls(settings.hangAt)
        yield* TestClock.adjust(deadline)
      }

      const state = yield* f.state(completed)
      assert.equal(state.job.status, "failed")

      if (state.job.status !== "failed") return
      assert.equal(state.job.reason.reason, expected)
      assert.notInclude(state.job.reason.message, "secret-should-not-leak")
      assert.isNull(state.tour)
      const calls = yield* f.agent.calls

      for (const entry of calls) assert.isFalse(existsSync(entry.cwd))
    }),
  )
}

it.live("reports a missing selected runner and retries after it becomes available", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ ready: false })

    const { client } = yield* startBackend({
      ...f.env,
      GLASS_CLAUDE_COMMAND: "glass-missing-claude",
    })

    yield* client.WriteTour({ pullRequest: f.ref, revision: f.revision })

    const missing = yield* client
      .WatchTour({ pullRequest: f.ref })
      .pipe(Stream.filter(completed), Stream.runHead, Effect.map(Option.getOrThrow))

    assert.equal(missing.job.status === "failed" && missing.job.reason.reason, "not-installed")
    yield* f.write
    assert.equal((yield* f.state(completed)).job.status, "failed")
    yield* f.agent.configure({ ready: true, output: claudeAnswer(answer) })
    yield* f.write
    assert.equal((yield* f.state(completed)).tour?.intent, answer.intent)
  }),
)

for (const [name, file, contents, message] of [
  [
    "a pi model without a provider",
    ".project-glass/settings.json",
    { tourModels: { pi: { modelId: "gpt-test" } } },
    "Couldn't read settings",
  ],
  [
    "an empty pi provider",
    ".project-glass/settings.json",
    { tourModels: { pi: { provider: "", modelId: "gpt-test" } } },
    "Couldn't read settings",
  ],
  ["missing pi authentication", ".pi/agent/auth.json", {}, "Sign into glass-test"],
  [
    "an unknown pi model",
    ".project-glass/settings.json",
    { tourModels: { pi: { provider: "glass-test", modelId: "missing" } }, tourEngine: "pi" },
    "not available",
  ],
  [
    "invalid pi model configuration",
    ".pi/agent/models.json",
    { providers: { "glass-test": { api: "invalid" } } },
    "configuration",
  ],
] as const) {
  it.live(`reports ${name} without probing Claude Code or invoking generation`, () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const pi = yield* fakeModelProvider(f.home, { output: JSON.stringify(answer) })
      yield* f.useEngine("pi")
      yield* Effect.promise(() => writeFile(join(f.home, file), JSON.stringify(contents)))
      yield* f.write
      const state = yield* f.state(completed)
      assert.equal(state.job.status, "failed")

      if (state.job.status !== "failed") return
      assert.equal(state.job.reason.reason, "not-ready")
      assert.include(state.job.reason.message, message)
      assert.equal(yield* f.agent.log, "")
      assert.isEmpty(pi.calls)
    }),
  )
}

it.live("rejects a Revision that changes during the GitHub file read", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    f.github.beforeNext(`/repos/${f.pr.owner}/${f.pr.repo}/pulls/`, () =>
      f.pr.push({ head: { sha: "h2", files: { "greet.ts": "new" } } }),
    )
    yield* f.write
    const state = yield* f.state(completed)
    assert.equal(state.job.status === "failed" && state.job.reason.reason, "github")
    assert.notInclude(yield* f.agent.log, '"stage":"generate"')
    assert.isNull(state.tour)
  }),
)

it.live("rejects a selected Claude Code without required restrictions even when pi is ready", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ ready: true, helpOutput: "unsupported version" })
    const pi = yield* fakeModelProvider(f.home, { output: JSON.stringify(answer) })
    yield* f.write
    const state = yield* f.state(completed)
    assert.equal(state.job.status === "failed" && state.job.reason.reason, "not-ready")
    assert.isNull(state.tour)
    assert.notInclude(yield* f.agent.log, '"stage":"generate"')
    assert.isEmpty(pi.calls)
  }),
)

it.live(
  "keeps jobs after subscribers leave and replaces a running job without publishing its result",
  () =>
    Effect.gen(function* () {
      const gate = join(yield* isolatedHome, "release")
      const f = yield* fixture({ gate })

      const observer = yield* f.client
        .WatchTour({ pullRequest: f.ref })
        .pipe(Stream.runDrain, Effect.forkChild)

      yield* f.write
      yield* f.agent.untilCalls("prompted")
      yield* Fiber.interrupt(observer)
      const replaced = (yield* f.agent.calls).find((entry) => entry.stage === "generate")!

      const second = f.github.seedPullRequest({
        base: { sha: "b0", files: {} },
        head: { sha: "h1", files: { "greet.ts": "hi" } },
        changedFiles: [{ path: "greet.ts", status: "added" }],
      })

      const other = new PullRequestRef({
        owner: second.owner,
        repo: second.repo,
        number: second.number,
      })

      yield* f.client.WriteTour({ pullRequest: other, revision: f.revision })
      yield* f.agent.untilCalls("prompted", 2)
      yield* f.agent.configure({
        ready: true,
        output: claudeAnswer({ ...answer, intent: "Replacement wins." }),
      })
      yield* f.write
      assert.throws(() => process.kill(replaced.pid, 0))
      assert.isFalse(existsSync(replaced.cwd))
      assert.equal((yield* f.state(completed)).tour?.intent, "Replacement wins.")
      yield* Effect.promise(() => writeFile(gate, "release"))

      const otherSaved = yield* f.client
        .WatchTour({ pullRequest: other })
        .pipe(Stream.filter(completed), Stream.runHead, Effect.map(Option.getOrThrow))

      assert.equal(otherSaved.tour?.intent, answer.intent)
      assert.equal((yield* f.state(completed)).tour?.intent, "Replacement wins.")
    }),
)

it.live("writes a saved Tour from the requested GitHub Revision", () =>
  Effect.gen(function* () {
    const agent = yield* fakeAgent({
      ready: true,
      output: claudeAnswer(answer),
    })

    const github = yield* startFakeGitHub()

    const pr = github.seedPullRequest({
      title: "Greet people",
      base: { sha: "b0", files: { "greet.ts": "hello" } },
      head: { sha: "h1", files: { "greet.ts": "hello name" } },
      changedFiles: [
        {
          path: "greet.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-hello\n+hello name",
        },
      ],
    })

    const ref = new PullRequestRef({ owner: pr.owner, repo: pr.repo, number: pr.number })
    const revision = new Revision({ base: "b0", head: "h1" })

    const { client } = yield* startBackend({
      GH_TOKEN: VIEWER.token,
      GLASS_GITHUB_API_URL: github.url,
      GLASS_CLAUDE_COMMAND: agent.command,
    })

    const before = yield* client.WatchTour({ pullRequest: ref }).pipe(Stream.runHead)
    assert.deepStrictEqual(Option.getOrThrow(before), { tour: null, job: { status: "idle" } })

    yield* client.WriteTour({ pullRequest: ref, revision })

    const saved = yield* client.WatchTour({ pullRequest: ref }).pipe(
      Stream.filter((state) => state.tour !== null),
      Stream.runHead,
    )

    const state = Option.getOrThrow(saved)
    assert.equal(state.tour?.intent, answer.intent)
    assert.deepStrictEqual(state.tour?.chapters, answer.chapters)
    assert.deepStrictEqual(state.tour?.revision, revision)
    assert.equal(state.job.status, "idle")
    const input = yield* agent.log
    assert.include(input, "Greet people")
    assert.include(input, "+hello name")
  }),
)

it.live("uses a custom provider's key from Pi's model configuration", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const pi = yield* fakeModelProvider(f.home, { output: JSON.stringify(answer) })
    yield* f.useEngine("pi")
    yield* Effect.promise(async () => {
      await writeFile(join(f.home, ".pi", "agent", "auth.json"), "{}")
      await writeFile(
        join(f.home, ".pi", "agent", "models.json"),
        JSON.stringify({
          providers: {
            "glass-test": {
              api: "openai-completions",
              baseUrl: pi.url,
              apiKey: "test-model-key",
              models: [{ id: "gpt-test" }],
            },
          },
        }),
      )
    })
    yield* f.write
    assert.equal((yield* f.state(completed)).tour?.intent, answer.intent)
    assert.deepStrictEqual(pi.authorizations, ["Bearer test-model-key"])
  }),
)

it.live("uses the selected runner and never falls back after failure", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const pi = yield* fakeModelProvider(f.home, { output: JSON.stringify(answer) })
    yield* f.useEngine("pi")
    yield* f.write
    const saved = yield* f.state(completed)
    assert.equal(saved.tour?.intent, answer.intent)
    assert.equal(yield* f.agent.log, "")
    assert.lengthOf(pi.calls, 1)
    const request = pi.calls[0]!
    assert.equal(request.model, "gpt-test")
    assert.isUndefined(request.tools)
    assert.deepStrictEqual(request.messages[0], { role: "system", content: tourInstructions })
    assert.include(request.messages[1]!.content, "Greet people")
    assert.include(request.messages[1]!.content, "+hello name")
    assert.include(request.messages[1]!.content, "Output JSON Schema:")
    const files = yield* Effect.promise(() => readdir(join(f.home, ".pi", "agent")))
    assert.notInclude(files, "sessions")

    yield* f.useEngine("claude-code")
    yield* f.write
    assert.equal((yield* f.state(completed)).tour?.intent, answer.intent)
    assert.lengthOf(pi.calls, 1)

    yield* f.agent.configure({ ready: false, output: "" })
    yield* f.write
    const rejected = yield* f.state(completed)
    assert.equal(rejected.job.status === "failed" && rejected.job.reason.reason, "not-ready")
    assert.lengthOf(pi.calls, 1)

    const claudeCalls = yield* f.agent.log
    yield* pi.configure({ output: "not JSON" })
    yield* f.useEngine("pi")
    yield* f.write
    const invalid = yield* f.state(completed)
    assert.equal(invalid.job.status === "failed" && invalid.job.reason.reason, "unusable-output")
    assert.deepStrictEqual(invalid.tour, rejected.tour)
    assert.equal(yield* f.agent.log, claudeCalls)
  }),
)

for (const [name, settings, expected] of [
  ["invalid answer shape", { output: JSON.stringify({ chapters: "wrong" }) }, "unusable-output"],
  [
    "truncated output",
    { output: JSON.stringify(answer), finishReason: "length" },
    "unusable-output",
  ],
  [
    "authentication rejection",
    { output: "401 unauthorized secret-should-not-leak", status: 401 },
    "authentication",
  ],
  ["provider failure", { output: "secret-should-not-leak", status: 500 }, "runner"],
  ["slow generation", { output: "", hang: true }, "timeout"],
] as const) {
  it.effect(`reports pi SDK ${name} without leaking provider output`, () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const pi = yield* fakeModelProvider(f.home, settings)
      yield* f.useEngine("pi")
      yield* f.write

      if (expected === "timeout") {
        yield* pi.received(1)
        yield* TestClock.adjust(deadline)
      }

      const state = yield* f.state(completed)
      assert.equal(state.job.status, "failed")

      if (state.job.status !== "failed") return
      assert.equal(state.job.reason.reason, expected)
      assert.notInclude(state.job.reason.message, "secret-should-not-leak")
      assert.isNull(state.tour)
      assert.equal(yield* f.agent.log, "")
      assert.lengthOf(pi.calls, 1)

      if (expected === "timeout") yield* pi.cancelled(1)
    }),
  )
}

it.live("writes a Tour with the pi CLI's model and none of pi's tools or resources", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const { models } = yield* f.client.GetEngineSettings({ feature: "tours" })
    yield* f.client.SetEngineSettings({
      feature: "tours",
      engineSettings: {
        engine: "pi-cli",
        models: { ...models, "pi-cli": { provider: "litellm", modelId: "deepseek-test" } },
      },
    })
    yield* f.piCli.configure({
      ready: true,
      modelsOutput: piCliModels,
      output: piCliOutput({ content: [{ type: "text", text: JSON.stringify(answer) }] }),
    })
    yield* f.write
    assert.equal((yield* f.state(completed)).tour?.intent, answer.intent)
    assert.equal(yield* f.agent.log, "")
    const calls = yield* f.piCli.calls
    const generate = calls.find((call) => call.stage === "generate")!
    const prompted = calls.find((call) => call.stage === "prompted")!

    for (const flag of ["--no-tools", "--no-extensions", "--no-mcp", "--no-session"])
      assert.include(generate.args, flag)
    assert.include(generate.args.join(" "), "--provider litellm --model deepseek-test")
    assert.equal(prompted.systemPrompt, tourInstructions)
    assert.include(prompted.input, "+hello name")
    assert.include(prompted.input, "Output JSON Schema:")
  }),
)

for (const [name, settings, expected] of [
  [
    "a model it doesn't list",
    { modelsOutput: piCliModels.replace("anthropic  claude-sonnet-5-5", "") },
    "not-ready",
  ],
  [
    "an authentication rejection",
    { output: piCliOutput({ stopReason: "error", errorMessage: "401 secret-should-not-leak" }) },
    "authentication",
  ],
  [
    "a provider failure",
    { output: piCliOutput({ stopReason: "error", errorMessage: "secret-should-not-leak" }) },
    "runner",
  ],
  ["an unsuccessful exit", { exitCode: 1, stderr: "secret-should-not-leak" }, "runner"],
  [
    "a truncated answer",
    {
      output: piCliOutput({
        stopReason: "length",
        content: [{ type: "text", text: JSON.stringify(answer) }],
      }),
    },
    "unusable-output",
  ],
  [
    "an answer that isn't a Tour",
    { output: piCliOutput({ content: [{ type: "text", text: "not JSON" }] }) },
    "unusable-output",
  ],
] as const) {
  it.live(`reports pi CLI ${name} without leaking its output`, () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.piCli.configure({ ready: true, output: "", modelsOutput: piCliModels, ...settings })
      yield* f.useEngine("pi-cli")
      yield* f.write
      const state = yield* f.state(completed)
      assert.equal(state.job.status, "failed")

      if (state.job.status !== "failed") return
      assert.equal(state.job.reason.reason, expected)
      assert.notInclude(state.job.reason.message, "secret-should-not-leak")
      assert.isNull(state.tour)

      if (expected === "not-ready") assert.notInclude(yield* f.piCli.log, '"stage":"generate"')
    }),
  )
}

it.live("cancels Pi's model request and resolves its model again on the next job", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const pi = yield* fakeModelProvider(f.home, { output: "", hang: true })
    yield* f.useEngine("pi")
    yield* f.write

    const writing = yield* f.state(
      (state) => state.job.status === "writing" && state.job.runner !== null,
    )

    assert.equal(
      writing.job.status === "writing" && writing.job.runner?.model,
      "glass-test/gpt-test",
    )
    yield* pi.received(1)
    yield* f.client.CancelTour({ pullRequest: f.ref })
    assert.deepStrictEqual(yield* f.state(completed), { tour: null, job: { status: "idle" } })
    yield* pi.cancelled(1)

    yield* Effect.promise(() =>
      writeFile(
        join(f.home, ".project-glass", "settings.json"),
        JSON.stringify({
          tourModels: { pi: { provider: "glass-test", modelId: "missing" } },
          tourEngine: "pi",
        }),
      ),
    )
    yield* f.write
    const unavailable = yield* f.state(completed)
    assert.equal(unavailable.job.status === "failed" && unavailable.job.reason.reason, "not-ready")
    assert.lengthOf(pi.calls, 1)
  }),
)

const stopped = (helper: RunningHelper) =>
  eventually(
    Effect.sync(() => {
      for (const pid of [helper.pid, helper.parentPid, helper.childPid])
        assert.throws(() => process.kill(pid, 0))
      assert.isFalse(existsSync(helper.cwd))
    }),
  )

it.live("keeps RPCs responsive and kills the Pi credential helper tree on cancel", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const pi = yield* fakeModelProvider(f.home, { output: JSON.stringify(answer) })
    yield* f.useEngine("pi")
    const helper = yield* piCredentialHelper(f.home)
    yield* helper.hang
    yield* f.write
    const running = yield* eventually(helper.running)
    assert.equal((yield* f.client.GetConnection()).login, VIEWER.login)
    yield* f.client.CancelTour({ pullRequest: f.ref })
    assert.deepStrictEqual(yield* f.state(completed), { tour: null, job: { status: "idle" } })
    assert.isEmpty(pi.calls)
    yield* stopped(running)
  }),
)

it.effect("enforces the Tour deadline while a Pi credential helper is blocked", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const pi = yield* fakeModelProvider(f.home, { output: JSON.stringify(answer) })
    yield* f.useEngine("pi")
    const helper = yield* piCredentialHelper(f.home)
    yield* helper.hang
    yield* f.write
    const running = yield* eventually(helper.running)
    yield* TestClock.adjust(deadline)
    const state = yield* f.state(completed)
    assert.equal(state.job.status === "failed" && state.job.reason.reason, "timeout")
    assert.isEmpty(pi.calls)
    yield* stopped(running)
  }),
)

it.live("retries failed credential helpers and picks up rotated keys without restarting", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const pi = yield* fakeModelProvider(f.home, { output: JSON.stringify(answer) })
    yield* f.useEngine("pi")
    const helper = yield* piCredentialHelper(f.home)
    yield* f.write
    const failed = yield* f.state(completed)
    assert.equal(failed.job.status === "failed" && failed.job.reason.reason, "not-ready")
    assert.isEmpty(pi.calls)

    yield* helper.setKey("synthetic-first")
    yield* f.write
    assert.equal((yield* f.state(completed)).tour?.intent, answer.intent)

    yield* helper.setKey("synthetic-second")
    yield* f.write
    assert.equal((yield* f.state(completed)).tour?.intent, answer.intent)
    assert.deepStrictEqual(pi.authorizations, ["Bearer synthetic-first", "Bearer synthetic-second"])
  }),
)

it.live("cancels readiness checks and loses only the running job on a backend restart", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ hangAt: "auth" })
    yield* f.write
    yield* f.agent.untilCalls("auth")
    const readiness = (yield* f.agent.calls)[0]!
    yield* f.client.CancelTour({ pullRequest: f.ref })
    assert.deepStrictEqual(yield* f.state(completed), { tour: null, job: { status: "idle" } })
    assert.throws(() => process.kill(readiness.pid, 0))
    assert.isFalse(existsSync(readiness.cwd))
    yield* f.agent.configure({ ready: true, output: "", hangAt: "generate" })
    yield* f.write
    yield* f.state((state) => state.job.status === "writing" && state.job.runner !== null)
    const restored = yield* f.restart

    assert.deepStrictEqual(restored, { tour: null, job: { status: "idle" } })
  }),
)

it.live(
  "rewrites a Tour for a newer Revision, streaming the old Tour until the replacement is saved",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.write
      const saved = (yield* f.state((state) => state.tour !== null)).tour!
      const gate = join(yield* isolatedHome, "release")
      f.pr.push({
        head: { sha: "h2", files: { "greet.ts": "hello there", "new.ts": "new" } },
        changedFiles: [
          {
            path: "greet.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: "@@ -1 +1 @@\n-hello\n+hello there",
          },
          { path: "new.ts", status: "added" },
        ],
      })
      yield* f.agent.configure({
        ready: true,
        gate,
        output: claudeAnswer({
          ...answer,
          intent: "Rewritten.",
          chapters: [
            { ...answer.chapters[0]!, files: [{ path: "new.ts", summary: "Adds a file." }] },
          ],
        }),
      })

      const states = yield* f.client.WatchTour({ pullRequest: f.ref }).pipe(
        Stream.takeUntil((state) => state.tour?.intent === "Rewritten."),
        Stream.runCollect,
        Effect.forkChild,
      )

      const requested = new Revision({ base: "b0", head: "h2" })
      yield* f.client.WriteTour({ pullRequest: f.ref, revision: requested })
      yield* f.agent.untilCalls("prompted", 2)
      f.pr.push({ head: { sha: "h3", files: { "greet.ts": "later" } } })
      yield* Effect.promise(() => writeFile(gate, "release"))
      const streamed = yield* Fiber.join(states)
      const rewritten = streamed.at(-1)!

      for (const state of streamed.slice(0, -1)) assert.deepStrictEqual(state.tour, saved)
      assert.isTrue(
        streamed.some((state) => state.job.status === "writing" && state.job.runner === null),
      )
      assert.isTrue(
        streamed.some((state) => state.job.status === "writing" && state.job.runner !== null),
      )
      assert.deepStrictEqual(rewritten.job, { status: "idle" })
      assert.deepStrictEqual(rewritten.tour?.revision, requested)
      assert.isAbove(rewritten.tour!.writtenAt.epochMilliseconds, saved.writtenAt.epochMilliseconds)
      const restored = yield* f.restart

      assert.deepStrictEqual(restored, { tour: rewritten.tour, job: { status: "idle" } })
    }),
)
