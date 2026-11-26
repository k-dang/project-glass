import {
  applyTranscriptUpdate,
  type CapturedContext,
  emptyTranscript,
  FollowedRepository,
  type Image,
  isWaiting,
  type NewThread,
  type RequestAnswer,
  type RequestPart,
  type Transcript,
  SandboxPlace,
  type SandboxStatus,
  localPlace,
  type Turn,
} from "@glass/contracts"
import { Effect, Exit, Option, Predicate, Schema, Scope, Stream } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { startFakeGitHub } from "./fakeGitHub"
import { VIEWER } from "./fakePullRequest"
import { installFakeSandboxProvider } from "./fakeSandboxProvider"
import { seedClone } from "./gitRepositories"
import { isolatedHome, startBackend } from "./harness"
import { scriptedReviews } from "./scriptedReviews"
import { vi } from "vite-plus/test"

export const repository = new FollowedRepository({ owner: "glass-demo", repo: "greeter" })

export const scriptedHost = fileURLToPath(
  new URL("../dist-test/scriptedAgentHost.mjs", import.meta.url),
)

export const threadsFixtureWith = ({
  agentHostBundle = scriptedHost,
  agentRunners,
  git = false,
}: {
  readonly agentHostBundle?: string
  readonly agentRunners?: Parameters<typeof startBackend>[2]
  readonly git?: boolean
} = {}) =>
  Effect.gen(function* () {
    const github = yield* startFakeGitHub({ git })
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
      GLASS_GIT_REMOTE: github.gitUrl,
      GLASS_AGENT_HOST_BUNDLE: agentHostBundle,
    }

    const serverScope = yield* Scope.make()
    yield* Effect.addFinalizer((exit) => Scope.close(serverScope, exit))

    const { client, baseUrl, mcpCredentials } = yield* startBackend(env, home, agentRunners).pipe(
      Effect.provideService(Scope.Scope, serverScope),
    )

    const quit = Scope.close(serverScope, Exit.void)

    const launch = startBackend(env, home, agentRunners).pipe(
      Effect.map((backend) => backend.client),
    )

    const watch = (
      threadId: string,
      until: (transcript: Transcript) => boolean,
      backend = client,
    ) =>
      backend.WatchTranscript({ threadId }).pipe(
        Stream.scan(() => emptyTranscript, applyTranscriptUpdate),
        Stream.filter(until),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      )

    const transcript = (
      threadId: string,
      until: (turns: ReadonlyArray<Turn>) => boolean,
      backend = client,
    ) =>
      watch(threadId, ({ turns }) => until(turns), backend).pipe(Effect.map(({ turns }) => turns))

    const sandboxStatus = (
      threadId: string,
      until: (status: SandboxStatus) => boolean,
      backend = client,
    ) =>
      backend.WatchThreads().pipe(
        Stream.map((threads) => threads.find(({ id }) => id === threadId)?.sandbox ?? null),
        Stream.filter((status): status is SandboxStatus => status !== null && until(status)),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      )

    const send = (threadId: string, message: string, images: ReadonlyArray<Image> = []) =>
      client.SendMessage({ threadId, message, images, feedback: [] })

    const start = (
      message = "Say hello",
      harness: Pick<NewThread, "harness" | "model" | "effort"> &
        Partial<Pick<NewThread, "permissionMode" | "skillPacks" | "localSkills">> = {
        harness: "pi",
        model: null,
        effort: null,
      },
      images: ReadonlyArray<Image> = [],
    ) =>
      client.LinkLocalCheckout({ path: clone.checkout }).pipe(
        Effect.andThen(
          client.CreateThread({
            repository,
            baseBranch: "main",
            message,
            images,
            permissionMode: null,
            place: localPlace,
            skillPacks: [],
            localSkills: false,
            ...harness,
          }),
        ),
      )

    const startSandbox = (
      message = "Say hello",
      harness: Pick<NewThread, "harness" | "model" | "effort"> &
        Partial<Pick<NewThread, "skillPacks" | "localSkills">> = {
        harness: "pi",
        model: null,
        effort: null,
      },
    ) =>
      client.CreateThread({
        repository,
        baseBranch: "main",
        message,
        images: [],
        permissionMode: null,
        place: SandboxPlace.make({ providerId: "fake" }),
        skillPacks: [],
        localSkills: false,
        ...harness,
      })

    const answering = (
      threadId: string,
      until: (turns: ReadonlyArray<Turn>) => boolean,
      answer: (part: RequestPart) => RequestAnswer,
    ) => {
      const answered = new Set<string>()

      return client.WatchTranscript({ threadId }).pipe(
        Stream.scan(() => emptyTranscript, applyTranscriptUpdate),
        Stream.map(({ turns }) => turns),
        Stream.tap((turns) =>
          Effect.forEach(
            turns.flatMap(({ parts }) => parts.filter(isWaiting)),
            (part) => {
              if (answered.has(part.requestId)) return Effect.void
              answered.add(part.requestId)

              return client.AnswerRequest({
                threadId,
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
      github,
      baseUrl,
      mcpCredentials,
      threads: client.WatchThreads().pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
      home,
      clone,
      release: (name: string) => Effect.sync(() => writeFileSync(join(gates, name), "")),
      reviews: scriptedReviews(gates),
      watch,
      transcript,
      sandboxStatus,
      send,
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

export const threadsFixture = threadsFixtureWith()

export const settled = (count: number) => (turns: ReadonlyArray<Turn>) =>
  turns.length === count && turns.every((turn) => turn.ended !== null)

export const lastText = (turn: Turn | undefined) =>
  turn?.parts.findLast((part) => Predicate.isTagged(part, "Text"))

export const holding = (turns: ReadonlyArray<Turn>) =>
  turns.some(({ parts }) =>
    parts.some((part) => Predicate.isTagged(part, "Text") && part.text === "Holding."),
  )

type Client = Effect.Success<typeof threadsFixture>["client"]

export const watchGlobal = (client: Client, until: (transcript: Transcript) => boolean) =>
  client.WatchGlobalTranscript().pipe(
    Stream.scan(() => emptyTranscript, applyTranscriptUpdate),
    Stream.filter(until),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  )

export const globalTurns = (client: Client, until: (turns: ReadonlyArray<Turn>) => boolean) =>
  watchGlobal(client, ({ turns }) => until(turns)).pipe(Effect.map(({ turns }) => turns))

export const sendGlobal = (
  client: Client,
  message: string,
  context: CapturedContext | null = null,
) => client.SendGlobalMessage({ message, images: [], context })

export const outcomesInStartedWorkUpdates = (turns: ReadonlyArray<Turn>) =>
  turns.flatMap(({ context }) =>
    Predicate.isTagged(context, "StartedWorkUpdate") ? context.work : [],
  )

export const threadOutcomesInStartedWorkUpdates = (turns: ReadonlyArray<Turn>) =>
  outcomesInStartedWorkUpdates(turns).flatMap((work) =>
    Predicate.isTagged(work, "Thread") ? [[work.threadId, work.outcome] as const] : [],
  )

export const lastSettled = (message: string) => (turns: ReadonlyArray<Turn>) =>
  turns.at(-1)?.message === message && turns.every((turn) => turn.ended !== null)

export const glassCall = (name: string, args: Schema.JsonObject) =>
  `call:${name} ${JSON.stringify(args)}`

export const glassCalls = (turn: Turn | undefined) =>
  turn?.parts.flatMap((part) =>
    Predicate.isTagged(part, "ToolCall") ? [{ status: part.status, output: part.output }] : [],
  )

const decodeResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Tuple([Schema.Struct({ text: Schema.String })])),
)

export const calledBy = (turn: Turn | undefined) => {
  const [called] = glassCalls(turn) ?? []

  return { status: called?.status, text: decodeResult(called?.output)[0].text }
}
