import {
  applyTranscriptUpdate,
  type CapturedContext,
  emptyTranscript,
  FollowedRepository,
  type Image,
  isWaiting,
  type NewConversation,
  type RequestAnswer,
  type RequestPart,
  type Transcript,
  SandboxPlace,
  type SandboxStatus,
  localPlace,
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

export const scriptedHost = fileURLToPath(
  new URL("../dist-test/scriptedAgentHost.mjs", import.meta.url),
)

export const conversationsFixtureWith = ({ agentHostBundle = scriptedHost } = {}) =>
  Effect.gen(function* () {
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
      GLASS_AGENT_HOST_BUNDLE: agentHostBundle,
    }

    const serverScope = yield* Scope.make()
    yield* Effect.addFinalizer((exit) => Scope.close(serverScope, exit))

    const { client, baseUrl, mcpCredentials } = yield* startBackend(env, home).pipe(
      Effect.provideService(Scope.Scope, serverScope),
    )

    const quit = Scope.close(serverScope, Exit.void)

    const launch = startBackend(env, home).pipe(Effect.map((backend) => backend.client))

    const watch = (
      conversationId: string,
      until: (transcript: Transcript) => boolean,
      backend = client,
    ) =>
      backend.WatchTranscript({ conversationId }).pipe(
        Stream.scan(() => emptyTranscript, applyTranscriptUpdate),
        Stream.filter(until),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      )

    const transcript = (
      conversationId: string,
      until: (turns: ReadonlyArray<Turn>) => boolean,
      backend = client,
    ) =>
      watch(conversationId, ({ turns }) => until(turns), backend).pipe(
        Effect.map(({ turns }) => turns),
      )

    const sandboxStatus = (
      conversationId: string,
      until: (status: SandboxStatus) => boolean,
      backend = client,
    ) =>
      backend.WatchConversations().pipe(
        Stream.map(
          (conversations) => conversations.find(({ id }) => id === conversationId)?.sandbox ?? null,
        ),
        Stream.filter((status): status is SandboxStatus => status !== null && until(status)),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      )

    const send = (conversationId: string, message: string, images: ReadonlyArray<Image> = []) =>
      client.SendMessage({ conversationId, message, images, feedback: [] })

    const start = (
      message = "Say hello",
      harness: Pick<NewConversation, "harness" | "model" | "effort"> &
        Partial<Pick<NewConversation, "permissionMode" | "skillPacks" | "localSkills">> = {
        harness: "pi",
        model: null,
        effort: null,
      },
      images: ReadonlyArray<Image> = [],
    ) =>
      client.LinkLocalCheckout({ path: clone.checkout }).pipe(
        Effect.andThen(
          client.CreateConversation({
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
      harness: Pick<NewConversation, "harness" | "model" | "effort"> &
        Partial<Pick<NewConversation, "skillPacks" | "localSkills">> = {
        harness: "pi",
        model: null,
        effort: null,
      },
    ) =>
      client.CreateConversation({
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
      conversationId: string,
      until: (turns: ReadonlyArray<Turn>) => boolean,
      answer: (part: RequestPart) => RequestAnswer,
    ) => {
      const answered = new Set<string>()

      return client.WatchTranscript({ conversationId }).pipe(
        Stream.scan(() => emptyTranscript, applyTranscriptUpdate),
        Stream.map(({ turns }) => turns),
        Stream.tap((turns) =>
          Effect.forEach(
            turns.flatMap(({ parts }) => parts.filter(isWaiting)),
            (part) => {
              if (answered.has(part.requestId)) return Effect.void
              answered.add(part.requestId)

              return client.AnswerRequest({
                conversationId,
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
      conversations: client
        .WatchConversations()
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
      home,
      clone,
      release: (name: string) => Effect.sync(() => writeFileSync(join(gates, name), "")),
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

export const conversationsFixture = conversationsFixtureWith()

export const settled = (count: number) => (turns: ReadonlyArray<Turn>) =>
  turns.length === count && turns.every((turn) => turn.ended !== null)

export const lastText = (turn: Turn | undefined) =>
  turn?.parts.findLast((part) => Predicate.isTagged(part, "Text"))

export const holding = (turns: ReadonlyArray<Turn>) =>
  turns.some(({ parts }) =>
    parts.some((part) => Predicate.isTagged(part, "Text") && part.text === "Holding."),
  )

type Client = Effect.Success<typeof conversationsFixture>["client"]

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

export const outcomesInGlobalConversationUpdates = (turns: ReadonlyArray<Turn>) =>
  turns.flatMap(({ context }) =>
    Predicate.isTagged(context, "GlobalConversationUpdate") ? context.work : [],
  )

export const conversationOutcomesInGlobalConversationUpdates = (turns: ReadonlyArray<Turn>) =>
  outcomesInGlobalConversationUpdates(turns).flatMap((work) =>
    Predicate.isTagged(work, "Conversation") ? [[work.conversationId, work.outcome] as const] : [],
  )

export const lastSettled = (message: string) => (turns: ReadonlyArray<Turn>) =>
  turns.at(-1)?.message === message && turns.every((turn) => turn.ended !== null)

export const glassCalls = (turn: Turn | undefined) =>
  turn?.parts.flatMap((part) =>
    Predicate.isTagged(part, "ToolCall") ? [{ status: part.status, output: part.output }] : [],
  )
