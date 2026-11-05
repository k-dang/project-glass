import {
  type ActivityLogError,
  ActivityPage,
  Agent,
  type AgentError,
  type AgentNotFound,
  type ConnectionError,
  type PullRequestAccessDenied,
  type PullRequestNotFound,
  type QueueError,
  type SettingsError,
  type StaleRevision,
  type ToDoError,
  PullRequestListings,
  PullRequestRef,
  QueuedPullRequest,
  Revision,
  ToDo,
  type Turn,
  TurnEnding,
} from "@glass/contracts"
import { Context, Effect, Match, Option, Schema, Stream } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { ActivityLog } from "../ActivityLog"
import { agentReviewMaterial } from "../agentReviewPrompt"
import { Agents } from "../Agents"
import { GitHubClient } from "../github/GitHubClient"
import { BackgroundGitHubRequest } from "../github/GitHubRequestPolicy"
import { PullRequestLists } from "../PullRequestLists"
import { Queue } from "../Queue"
import { ToDos } from "../ToDos"

/** A Glass failure, worded for the model to explain to the user. */
export class GlassToolFailure extends Schema.TaggedError<GlassToolFailure>()("GlassToolFailure", {
  message: Schema.String,
}) {}

const MAX_ACTIVITY = 100

const MAX_TURNS = 20

const MAX_TEXT_CHARS = 4_000

/** Keeps a PR's material within what the Agent programs take from one tool result. */
const MAX_DIFF_CHARS = 60_000

const readOnly = Context.make(Tool.Readonly, true).pipe(
  Context.add(Tool.Destructive, false),
  Context.add(Tool.OpenWorld, false),
)

const ListPullRequests = Tool.make("list_pull_requests", {
  description:
    "Lists the user's PR lists in Glass: PRs that need their review, their own PRs, and PRs they are reviewing, grouped by followed repository.",
  success: PullRequestListings,
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

const ListQueue = Tool.make("list_queue", {
  description:
    "Lists the PRs in the user's Queue: the PRs they lined up to review next, in order, each with the Revision Glass last saw.",
  success: Schema.Struct({ queue: Schema.Array(QueuedPullRequest) }),
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

const ListToDos = Tool.make("list_to_dos", {
  description: "Lists the user's To-dos in Glass, done or not, with their notes.",
  success: Schema.Struct({ toDos: Schema.Array(ToDo) }),
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

const ListRecentActivity = Tool.make("list_recent_activity", {
  description:
    "Lists the user's most recent Activity in Glass, newest first: PRs they opened, reviewed, and commented on, and other work they did.",
  parameters: Schema.Struct({
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_ACTIVITY })).annotate({
      description: `How many Activities to list, at most ${MAX_ACTIVITY}.`,
    }),
  }),
  success: ActivityPage,
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

const ListedAgent = Schema.Struct({
  agent: Agent,
  waiting: Schema.Boolean.annotate({
    description:
      "Whether the Agent is waiting for the user to answer a Question or Permission request.",
  }),
})

const ListAgents = Tool.make("list_agents", {
  description:
    "Lists the user's Agents: the named coding conversations working in a repository, with each one's repository, base branch, program, and whether it waits for the user's answer.",
  success: Schema.Struct({ agents: Schema.Array(ListedAgent) }),
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

const TurnSummary = Schema.Struct({
  message: Schema.String,
  sentAt: Schema.DateTimeUtcFromString,
  ending: Schema.NullOr(TurnEnding).annotate({
    description: "How the Turn ended, or null while it runs.",
  }),
  activity: Schema.Array(Schema.String).annotate({
    description: "What the Agent wrote and did in the Turn, in order, with long text cut short.",
  }),
})

const ReadAgentTranscript = Tool.make("read_agent_transcript", {
  description:
    "Reads an Agent's most recent Turns: each message the user sent, what the Agent wrote and which tools it used, and how the Turn ended. Includes Queued messages not yet delivered.",
  parameters: Schema.Struct({
    agentId: Schema.String.annotate({ description: "The Agent's id, from list_agents." }),
    turns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_TURNS })).annotate({
      description: `How many of the latest Turns to read, at most ${MAX_TURNS}.`,
    }),
  }),
  success: Schema.Struct({
    turns: Schema.Array(TurnSummary),
    earlierTurns: Schema.Int,
    queued: Schema.Array(Schema.String),
  }),
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

const ReadPullRequest = Tool.make("read_pull_request", {
  description:
    "Reads a PR's title, description, changed files with their diffs, and published Discussions at one Revision. Pass the Revision the user means, such as the one in a message's glass_context; leave it out to read the PR as it is now.",
  parameters: Schema.Struct({
    pullRequest: PullRequestRef,
    revision: Schema.optional(Revision),
  }),
  success: Schema.Struct({
    revision: Revision,
    title: Schema.String,
    description: Schema.String,
    files: Schema.Array(Schema.Json),
    discussions: Schema.Json,
    diffsLeftOut: Schema.Array(Schema.String).annotate({
      description: "Files whose diff was left out to keep the material readable.",
    }),
  }),
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

export const GlassTools = Toolkit.make(
  ListPullRequests,
  ListQueue,
  ListToDos,
  ListRecentActivity,
  ListAgents,
  ReadAgentTranscript,
  ReadPullRequest,
)

type ReadFailure =
  | ActivityLogError
  | AgentError
  | AgentNotFound
  | ConnectionError
  | PullRequestAccessDenied
  | PullRequestNotFound
  | QueueError
  | SettingsError
  | StaleRevision
  | ToDoError

const explained = (error: ReadFailure) =>
  new GlassToolFailure({
    message: Match.value(error).pipe(
      Match.tagsExhaustive({
        StaleRevision: () =>
          "The PR has changed since that Revision. Read it as it is now, and tell the user what changed.",
        PullRequestNotFound: () =>
          "GitHub has no such PR, or the user's GitHub login can't see it.",
        NoCredentials: () => "Glass isn't signed in to GitHub.",
        TokenRejected: () => "GitHub rejected Glass's GitHub login.",
        AgentNotFound: () =>
          "There's no Agent with that id. list_agents names the Agents there are.",
        PullRequestAccessDenied: ({ message }) => message,
        GitHubUnavailable: ({ message }) => message,
        ActivityLogError: ({ message }) => message,
        AgentError: ({ message }) => message,
        QueueError: ({ message }) => message,
        SettingsError: ({ message }) => message,
        ToDoError: ({ message }) => message,
      }),
    ),
  })

const textOf = (text: string) =>
  text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}… (cut short)` : text

const activityOf = (turn: Turn) =>
  turn.parts.map((part) =>
    Match.value(part).pipe(
      Match.tagsExhaustive({
        Text: ({ text }) => textOf(text),
        Thinking: () => "(thought)",
        ToolCall: ({ name, inputSummary, status }) =>
          `Tool ${name} ${status}${inputSummary === "" ? "" : `: ${inputSummary}`}`,
        Steer: ({ message }) => `User steered: ${textOf(message)}`,
        PermissionRequest: ({ toolName, inputSummary, status }) =>
          `Permission request for ${toolName} (${inputSummary}): ${status}`,
        Question: ({ questions, status }) =>
          `Question (${status}): ${questions.map(({ question }) => question).join(" / ")}`,
      }),
    ),
  )

/** Leaves out the largest diffs first until the rest fit. */
const withinBudget = (
  files: ReadonlyArray<ReturnType<typeof agentReviewMaterial>["files"][number]>,
) => {
  const sizes = files.map((file) => JSON.stringify(file.diff).length)
  const leftOut = new Set<number>()
  let total = sizes.reduce((sum, size) => sum + size, 0)

  for (const index of sizes.map((_, i) => i).toSorted((a, b) => sizes[b]! - sizes[a]!)) {
    if (total <= MAX_DIFF_CHARS) break
    leftOut.add(index)
    total -= sizes[index]!
  }

  return {
    files: files.map((file, index) => (leftOut.has(index) ? { ...file, diff: null } : file)),
    diffsLeftOut: files.flatMap((file, index) => (leftOut.has(index) ? [file.path] : [])),
  }
}

const first = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  stream.pipe(Stream.runHead, Effect.map(Option.getOrThrow))

export const GlassToolHandlers = GlassTools.toLayer(
  Effect.gen(function* () {
    const lists = yield* PullRequestLists
    const queue = yield* Queue
    const toDos = yield* ToDos
    const activityLog = yield* ActivityLog
    const github = yield* GitHubClient
    const agents = yield* Agents

    return GlassTools.of({
      list_pull_requests: () =>
        lists
          .list()
          .pipe(Effect.provideService(BackgroundGitHubRequest, true), Effect.mapError(explained)),
      list_queue: () =>
        queue.saved().pipe(
          Effect.map((queued) => ({ queue: queued })),
          Effect.mapError(explained),
        ),
      list_to_dos: () =>
        toDos.list().pipe(
          Effect.map((listed) => ({ toDos: listed })),
          Effect.mapError(explained),
        ),
      list_recent_activity: ({ limit }) =>
        github.knownViewer.pipe(
          Effect.flatMap(({ login }) => activityLog.list(login, limit)),
          Effect.mapError(explained),
        ),
      list_agents: () =>
        Effect.all([first(agents.watch()), first(agents.watchWaiting())]).pipe(
          Effect.map(([listed, waiting]) => ({
            agents: listed.map((agent) => ({ agent, waiting: waiting.includes(agent.id) })),
          })),
          Effect.mapError(explained),
        ),
      read_agent_transcript: ({ agentId, turns }) =>
        agents.readTranscript(agentId).pipe(
          Effect.map((transcript) => ({
            turns: transcript.turns.slice(-turns).map((turn) => ({
              message: textOf(turn.message),
              sentAt: turn.sentAt,
              ending: turn.ended?.ending ?? null,
              activity: activityOf(turn),
            })),
            earlierTurns: Math.max(0, transcript.turns.length - turns),
            queued: transcript.queued.map(({ message }) => textOf(message)),
          })),
          Effect.mapError(explained),
        ),
      read_pull_request: ({ pullRequest, revision }) =>
        Effect.gen(function* () {
          const read = revision ?? (yield* github.pullRequest(pullRequest)).revision

          const material = agentReviewMaterial(yield* github.reviewInput(pullRequest, read))

          return { revision: read, ...material, ...withinBudget(material.files) }
        }).pipe(Effect.mapError(explained)),
    })
  }),
)
