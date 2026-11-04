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
  type SandboxStatus,
  thisMac,
  type Turn,
} from "@glass/contracts"
import { Effect, Exit, Option, Predicate, Scope, Stream } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { startFakeGitHub } from "./fakeGitHub"
import { VIEWER } from "./fakePullRequest"
import { installFakeSandboxProvider } from "./fakeSandboxProvider"
import { seedClone } from "./gitRepositories"
import { isolatedHome, startBackend } from "./harness"
import { vi } from "vite-plus/test"

export const repository = new FollowedRepository({ owner: "glass-demo", repo: "greeter" })

const scriptedHost = fileURLToPath(new URL("../dist-test/scriptedAgentHost.mjs", import.meta.url))

export const agentsFixture = Effect.gen(function* () {
  const github = yield* startFakeGitHub()
  const home = yield* isolatedHome
  const repositories = yield* isolatedHome
  const gates = join(home, "gates")
  mkdirSync(gates)
  vi.stubEnv("GLASS_SCRIPTED_GATES", gates)

  const clone = seedClone(repositories, repository.owner, repository.repo)

  const sandboxes = installFakeSandboxProvider(home, {
    root: join(repositories, "sandboxes"),
    cloneFrom: clone.origin,
    piCommand: "unused",
    claudeCommand: "unused",
  })

  yield* Effect.addFinalizer(() => Effect.promise(sandboxes.stopHosts))

  const env = {
    GH_TOKEN: VIEWER.token,
    GLASS_GITHUB_API_URL: github.url,
    GLASS_AGENT_HOST_BUNDLE: scriptedHost,
  }

  const serverScope = yield* Scope.make()
  yield* Effect.addFinalizer((exit) => Scope.close(serverScope, exit))

  const { client } = yield* startBackend(env, home).pipe(
    Effect.provideService(Scope.Scope, serverScope),
  )

  const quit = Scope.close(serverScope, Exit.void)

  const launch = startBackend(env, home).pipe(Effect.map((backend) => backend.client))

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

  const sandboxStatus = (
    agentId: string,
    until: (status: SandboxStatus) => boolean,
    backend = client,
  ) =>
    backend.WatchAgents().pipe(
      Stream.map((agents) => agents.find(({ id }) => id === agentId)?.sandbox ?? null),
      Stream.filter((status): status is SandboxStatus => status !== null && until(status)),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    )

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
    release: (name: string) => Effect.sync(() => writeFileSync(join(gates, name), "")),
    watch,
    transcript,
    sandboxStatus,
    send,
    steer,
    answering,
    start,
    startSandbox,
    sandboxes,
    worktree: (name: string) =>
      join(home, ".project-glass", "worktrees", repository.owner, repository.repo, name),
    quit,
    launch,
    restart: quit.pipe(Effect.andThen(launch)),
  }
})

export const settled = (count: number) => (turns: ReadonlyArray<Turn>) =>
  turns.length === count && turns.every((turn) => turn.ended !== null)

export const claudeCode = {
  engine: "claude-code",
  model: null,
  effort: null,
  permissionMode: "bypassPermissions",
} as const

export const lastText = (turn: Turn | undefined) =>
  turn?.parts.findLast((part) => Predicate.isTagged(part, "Text"))

export const holding = (turns: ReadonlyArray<Turn>) =>
  turns.some(({ parts }) =>
    parts.some((part) => Predicate.isTagged(part, "Text") && part.text === "Holding."),
  )
