import {
  applyTranscriptUpdate,
  emptyTranscript,
  FollowedRepository,
  type Image,
  isWaiting,
  type NewAgent,
  type RequestAnswer,
  type RequestPart,
  type Transcript,
  SandboxPlace,
  thisMac,
  type Turn,
} from "@glass/contracts"
import { Effect, Exit, Option, Predicate, Scope, Stream } from "effect"
import { join } from "node:path"
import { bundledPi } from "./demoAgent"
import { type FakeModelSettings, fakeModelProvider, type PiSettings } from "./fakeModelProvider"
import { startFakeGitHub } from "./fakeGitHub"
import { VIEWER } from "./fakePullRequest"
import { installFakeSandboxProvider } from "./fakeSandboxProvider"
import { seedClone } from "./gitRepositories"
import { isolatedHome, startBackend } from "./harness"
import { startFakeAnthropic } from "./fakeAnthropic"
import { fakeAnthropicEnvironment } from "./pinnedClaude"
import { vi } from "vite-plus/test"

export const repository = new FollowedRepository({ owner: "glass-demo", repo: "greeter" })

/**
 * A backend on fake GitHub whose Agents run the real programs against fake models: the bundled pi on
 * a fake model provider, and the pinned Claude Code CLI on a fake Anthropic API.
 */
export const agentsFixture = Effect.fnUntraced(function* (
  settings: FakeModelSettings,
  piSettings: PiSettings = { retry: { enabled: false } },
) {
  const github = yield* startFakeGitHub()
  const home = yield* isolatedHome
  const repositories = yield* isolatedHome
  const model = yield* fakeModelProvider(home, settings, piSettings)
  const anthropic = yield* startFakeAnthropic
  const claudeEnvironment = fakeAnthropicEnvironment(home, anthropic.url)

  for (const [name, value] of Object.entries(claudeEnvironment)) vi.stubEnv(name, value)

  const claude = { ...anthropic, command: claudeEnvironment.GLASS_CLAUDE_COMMAND }

  const clone = seedClone(repositories, repository.owner, repository.repo)

  const sandboxes = installFakeSandboxProvider(home, {
    root: join(repositories, "sandboxes"),
    cloneFrom: clone.origin,
    piCommand: bundledPi,
    claudeCommand: claude.command,
  })

  yield* Effect.addFinalizer(() => Effect.promise(sandboxes.stopHosts))

  const env = {
    GH_TOKEN: VIEWER.token,
    GLASS_GITHUB_API_URL: github.url,
    GLASS_PI_COMMAND: bundledPi,
    GLASS_CLAUDE_COMMAND: claude.command,
  }

  const serverScope = yield* Scope.make()
  yield* Effect.addFinalizer((exit) => Scope.close(serverScope, exit))

  const { client } = yield* startBackend(env, home).pipe(
    Effect.provideService(Scope.Scope, serverScope),
  )

  const watch = (agentId: string, until: (transcript: Transcript) => boolean, backend = client) =>
    backend.WatchTranscript({ agentId }).pipe(
      Stream.scan(() => emptyTranscript, applyTranscriptUpdate),
      Stream.filter(until),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    )

  const transcript = (
    agentId: string,
    until: (turns: ReadonlyArray<Turn>) => boolean,
    backend = client,
  ) => watch(agentId, ({ turns }) => until(turns), backend).pipe(Effect.map(({ turns }) => turns))

  const send = (agentId: string, message: string, images: ReadonlyArray<Image> = []) =>
    client.SendMessage({ agentId, message, images })

  const steer = (agentId: string, message: string, images: ReadonlyArray<Image> = []) =>
    client.Steer({ agentId, message, images })

  const start = (
    message = "Say hello",
    program: Pick<NewAgent, "engine" | "model" | "effort"> &
      Partial<Pick<NewAgent, "permissionMode">> = { engine: "pi", model: null, effort: null },
    images: ReadonlyArray<Image> = [],
  ) =>
    client.LinkLocalCheckout({ path: clone.checkout }).pipe(
      Effect.andThen(
        client.CreateAgent({
          repository,
          baseBranch: "main",
          message,
          images,
          permissionMode: null,
          place: thisMac,
          ...program,
        }),
      ),
    )

  const startSandbox = (
    message = "Say hello",
    program: Pick<NewAgent, "engine" | "model" | "effort"> = {
      engine: "pi",
      model: null,
      effort: null,
    },
  ) =>
    client.CreateAgent({
      repository,
      baseBranch: "main",
      message,
      images: [],
      permissionMode: null,
      place: SandboxPlace.make({ providerId: "fake" }),
      ...program,
    })

  /** Watches an Agent's Turns until `until` holds, answering each request as it comes to wait. */
  const answering = (
    agentId: string,
    until: (turns: ReadonlyArray<Turn>) => boolean,
    answer: (part: RequestPart) => RequestAnswer,
  ) => {
    const answered = new Set<string>()

    return client.WatchTranscript({ agentId }).pipe(
      Stream.scan(() => emptyTranscript, applyTranscriptUpdate),
      Stream.map(({ turns }) => turns),
      Stream.tap((turns) =>
        Effect.forEach(
          turns.flatMap(({ parts }) => parts.filter(isWaiting)),
          (part) => {
            if (answered.has(part.requestId)) return Effect.void
            answered.add(part.requestId)

            return client.AnswerRequest({
              agentId,
              requestId: part.requestId,
              answer: answer(part),
            })
          },
          { discard: true },
        ),
      ),
      Stream.filter(until),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    )
  }

  return {
    client,
    agents: client.WatchAgents().pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
    home,
    clone,
    model,
    claude,
    watch,
    transcript,
    send,
    steer,
    answering,
    start,
    startSandbox,
    sandboxes,
    worktree: (name: string) =>
      join(home, ".project-glass", "worktrees", repository.owner, repository.repo, name),
    restart: Effect.gen(function* () {
      yield* Scope.close(serverScope, Exit.void)

      return (yield* startBackend(env, home)).client
    }),
  }
})

export const settled = (count: number) => (turns: ReadonlyArray<Turn>) =>
  turns.length === count && turns.every((turn) => turn.ended !== null)

/** A Claude Code Agent that asks nothing, for tests about something else. */
export const claudeCode = {
  engine: "claude-code",
  model: null,
  effort: null,
  permissionMode: "bypassPermissions",
} as const

export const lastText = (turn: Turn | undefined) =>
  turn?.parts.findLast((part) => Predicate.isTagged(part, "Text"))
