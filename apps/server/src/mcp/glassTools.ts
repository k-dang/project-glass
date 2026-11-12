import {
  AskUserResult,
  type ActivityLogError,
  ActivityPage,
  Agent,
  AgentEngine,
  AgentError,
  AgentModels,
  type AgentReviewFailure,
  AgentReviewState,
  Branches,
  type AgentNotFound,
  type ConnectionError,
  FollowedRepository,
  type InvalidLocalCheckout,
  LocalCheckout,
  MessageDelivery,
  MessageText,
  NeedsYouItem,
  type PullRequestAccessDenied,
  type PullRequestNotFound,
  type QueueError,
  type RequestWaiting,
  SandboxProviderInfo,
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
  AgentPlace,
  localPlace,
} from "@glass/contracts"
import { Context, Duration, Effect, Match, Option, Schema, Stream } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { ActivityLog } from "../ActivityLog"
import { AgentReviews } from "../AgentReviews"
import { PullRequestMaterial, pullRequestMaterial } from "../agentReviewPrompt"
import type { FileMaterial } from "../tourPrompt"
import { Agents } from "../Agents"
import { GitHubClient } from "../github/GitHubClient"
import { BackgroundGitHubRequest } from "../github/GitHubRequestPolicy"
import { FollowedRepositories } from "../FollowedRepositories"
import { LocalCheckouts } from "../LocalCheckouts"
import { AskProgress } from "./AskProgress"
import { McpCaller } from "./McpCredentials"
import { NeedsYou } from "../NeedsYou"
import {
  ASK_PROGRESS_SECONDS,
  ASK_TIMEOUT_DEFAULT_SECONDS,
  ASK_TIMEOUT_MAX_SECONDS,
  OutsideQuestions,
} from "../OutsideQuestions"
import { Sandboxes } from "../Sandboxes"
import { PullRequestLists } from "../PullRequestLists"
import { Queue } from "../Queue"
import { ToDos } from "../ToDos"

export class GlassToolFailure extends Schema.TaggedError<GlassToolFailure>()("GlassToolFailure", {
  message: Schema.String,
}) {}

const MAX_ACTIVITY = 100

const MAX_TURNS = 20

const MAX_TEXT_CHARS = 4_000

/** Caps a PR's diffs, the bulk of its material, within what the Agent programs take from one tool result. */
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

const ListNeedsYou = Tool.make("list_needs_you", {
  description:
    "Lists what waits on the user in Glass now: Agents with a Permission request or Question waiting, questions from an agent outside Glass, PRs that request their Review, and queued PRs whose Agent review is finished. Agents and outside questions come first, then the longest waiting.",
  success: Schema.Struct({ items: Schema.Array(NeedsYouItem) }),
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
    ...PullRequestMaterial.fields,
    diffsLeftOut: Schema.Array(Schema.String).annotate({
      description: "Files whose diff was left out to keep the material readable.",
    }),
  }),
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

const ListAgentPlaces = Tool.make("list_agent_places", {
  description:
    "Lists where the user can start an Agent. An Agent on this device works in a copy of a Local checkout, so its repository must be one of localCheckouts. An Agent in a Sandbox works in any followed repository, in a Sandbox from one of sandboxProviders. Each place runs only the Agent programs listed with it.",
  success: Schema.Struct({
    local: Schema.Struct({
      engines: Schema.Array(AgentEngine),
      localCheckouts: Schema.Array(LocalCheckout),
    }),
    sandboxProviders: Schema.Array(SandboxProviderInfo),
    followedRepositories: Schema.Array(FollowedRepository),
  }),
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

const ListAgentOptions = Tool.make("list_agent_options", {
  description:
    "Lists the base branches and models an Agent can start with, for a repository, place, and Agent program from list_agent_places.",
  parameters: Schema.Struct({
    place: AgentPlace,
    repository: FollowedRepository,
    engine: AgentEngine,
  }),
  success: Schema.Struct({
    ...Branches.fields,
    models: AgentModels,
  }),
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

const action = Context.make(Tool.Readonly, false).pipe(
  Context.add(Tool.Destructive, false),
  Context.add(Tool.Idempotent, false),
  Context.add(Tool.OpenWorld, false),
)

const CreateAgent = Tool.make("create_agent", {
  description:
    "Creates an Agent: a named coding conversation working on a branch of its own, made from a base branch of a repository. It starts its first Turn with the message, and appears in the user's Agents. This returns once Glass created the Agent, not when it finishes its Turn: read_agent_transcript shows its progress. Choose the place, program, base branch, and model from list_agent_places and list_agent_options, never from guesses. If this call fails without saying why, or is cut off, call list_agents before trying again rather than creating a second Agent.",
  parameters: Schema.Struct({
    repository: FollowedRepository,
    baseBranch: Schema.String.annotate({
      description: "The branch the Agent's branch starts from.",
    }),
    place: AgentPlace.annotate({
      description: "Where the Agent works: on this device, or in a Sandbox from a provider.",
    }),
    engine: AgentEngine.annotate({ description: "The Agent program that runs the Agent." }),
    model: Schema.NullOr(Schema.String).annotate({
      description: "A model id from list_agent_options, or null for the program's default.",
    }),
    effort: Schema.NullOr(Schema.String).annotate({
      description: "One of the model's Efforts, or null for its default.",
    }),
    message: MessageText.annotate({ description: "The Agent's first message: its task." }),
  }),
  success: Schema.Struct({ agent: Agent }),
  failure: GlassToolFailure,
}).annotateMerge(action)

const SendAgentMessage = Tool.make("send_agent_message", {
  description:
    "Sends a message to one of the user's Agents, as the user would from the Agent. An idle Agent starts a Turn with it; a busy Agent keeps it as a Queued message and starts on it after its running Turn. This returns once Glass accepted the message, not when the Agent answers: read_agent_transcript shows its progress. If this call fails without saying why, or is cut off, read the Agent's transcript before sending again rather than sending it twice.",
  parameters: Schema.Struct({
    agentId: Schema.String.annotate({ description: "The Agent's id, from list_agents." }),
    message: MessageText,
  }),
  success: Schema.Struct({
    delivery: MessageDelivery.annotate({
      description:
        "started: the Agent started a Turn with it. queued: it waits behind the running Turn.",
    }),
  }),
  failure: GlassToolFailure,
}).annotateMerge(action)

const ReadAgentReview = Tool.make("read_agent_review", {
  description:
    "Reads a PR's Agent review: the latest one written, with the Revision it reviewed, and whether one is being written now or failed.",
  parameters: Schema.Struct({ pullRequest: PullRequestRef }),
  success: AgentReviewState,
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

const minutes = ASK_TIMEOUT_DEFAULT_SECONDS / 60

const AskUser = Tool.make("ask_user", {
  description:
    `Asks the user a question and waits for their answer in the Glass Inbox, in Stopped on you. ` +
    `Waits ${minutes} minutes unless timeoutSeconds is set. timeoutSeconds is a whole number of seconds from 1 to ${ASK_TIMEOUT_MAX_SECONDS}, and cannot be longer than that. ` +
    `Glass sends a progress notification immediately and every ${ASK_PROGRESS_SECONDS} seconds while it waits, so a client that resets its timeout when progress arrives is not cut off before Glass's own limit. ` +
    `Pass a progress token on the call. The result is Answered with the user's answer (by is choice or text), TimedOut when they do not answer in time, or Cancelled when Glass shuts down. ` +
    `A timed out or cancelled question leaves the Inbox. choices are optional. The user can pick one or type their own answer. from is your name, shown beside the session that called.`,
  parameters: Schema.Struct({
    question: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)).annotate({
      description: "The question to show in the Inbox.",
    }),
    choices: Schema.optional(
      Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(200)))
        .check(Schema.isMinLength(1), Schema.isMaxLength(8), Schema.isUnique())
        .annotate({
          description:
            "Choices the user can pick. They can still type their own answer. Omit this to ask for text only.",
        }),
    ),
    from: Schema.optional(
      Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(80)).annotate({
        description: "Your name, shown beside the session that called. For example, Claude Code.",
      }),
    ),
    timeoutSeconds: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: ASK_TIMEOUT_MAX_SECONDS })).annotate(
        {
          description: `Seconds to wait. Defaults to ${ASK_TIMEOUT_DEFAULT_SECONDS}. At most ${ASK_TIMEOUT_MAX_SECONDS}.`,
        },
      ),
    ),
  }),
  success: AskUserResult,
  failure: GlassToolFailure,
}).annotateMerge(action)

const StartAgentReview = Tool.make("start_agent_review", {
  description:
    "Starts an Agent review of a PR at a Revision, as the user would from the PR. It appears beside the PR's diff once written. This returns once the review started, not when it is written, which takes minutes: read_agent_review shows its progress and result, or why it failed, such as the PR having changed since that Revision. Starting one replaces any review being written for the PR, so read_agent_review first and ask the user before replacing one.",
  parameters: Schema.Struct({
    pullRequest: PullRequestRef,
    revision: Revision.annotate({
      description: "The Revision to review, such as the one in a message's glass_context.",
    }),
  }),
  success: AgentReviewState,
  failure: GlassToolFailure,
}).annotateMerge(action)

export const GlassTools = Toolkit.make(
  ListPullRequests,
  ListQueue,
  ListToDos,
  ListRecentActivity,
  ListAgents,
  ListNeedsYou,
  ReadAgentTranscript,
  ReadPullRequest,
  ReadAgentReview,
  StartAgentReview,
  ListAgentPlaces,
  ListAgentOptions,
  CreateAgent,
  SendAgentMessage,
  AskUser,
)

type ServiceFailure =
  | ActivityLogError
  | AgentError
  | AgentReviewFailure
  | AgentNotFound
  | ConnectionError
  | InvalidLocalCheckout
  | PullRequestAccessDenied
  | PullRequestNotFound
  | QueueError
  | RequestWaiting
  | SettingsError
  | StaleRevision
  | ToDoError

const explained = (error: ServiceFailure) =>
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
        InvalidLocalCheckout: ({ message }) =>
          `${message} The user links one from New Agent in Agents; an Agent in a Sandbox needs none.`,
        PullRequestAccessDenied: ({ message }) => message,
        GitHubUnavailable: ({ message }) => message,
        ActivityLogError: ({ message }) => message,
        AgentError: ({ message }) => message,
        AgentReviewFailure: ({ message }) => message,
        RequestWaiting: () =>
          "The Agent is waiting for the user to answer its Question or Permission request, so it took no message. The user answers it in the Agent.",
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
const withinBudget = (files: ReadonlyArray<FileMaterial>) => {
  const leftOut = new Set<FileMaterial>()
  let total = files.reduce((sum, file) => sum + (file.diff?.length ?? 0), 0)

  for (const file of files.toSorted((a, b) => (b.diff?.length ?? 0) - (a.diff?.length ?? 0))) {
    if (total <= MAX_DIFF_CHARS) break
    leftOut.add(file)
    total -= file.diff?.length ?? 0
  }

  return {
    files: files.map((file) => (leftOut.has(file) ? { ...file, diff: null } : file)),
    diffsLeftOut: files.flatMap((file) => (leftOut.has(file) ? [file.path] : [])),
  }
}

const first = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  stream.pipe(Stream.runHead, Effect.map(Option.getOrThrow))

/** Talks to the MCP server already handling this call, so progress stays on that response. */
const waitingProgress = Effect.gen(function* () {
  const progress = yield* AskProgress.current
  let step = 0

  while (true) {
    step += 1
    yield* progress.notify(step)
    yield* Effect.sleep(Duration.seconds(ASK_PROGRESS_SECONDS))
  }
}).pipe(Effect.ignore)

export const GlassToolHandlers = GlassTools.toLayer(
  Effect.gen(function* () {
    const lists = yield* PullRequestLists
    const queue = yield* Queue
    const toDos = yield* ToDos
    const activityLog = yield* ActivityLog
    const github = yield* GitHubClient
    const agents = yield* Agents
    const followed = yield* FollowedRepositories
    const checkouts = yield* LocalCheckouts
    const sandboxes = yield* Sandboxes
    const agentReviews = yield* AgentReviews
    const needsYou = yield* NeedsYou
    const outsideQuestions = yield* OutsideQuestions

    const refuseUnofferedModel = Effect.fnUntraced(function* ({
      engine,
      place,
      model,
      effort,
    }: Tool.Parameters<typeof CreateAgent>) {
      const { defaultModel, models } = yield* agents.models(engine, place)
      const chosen = model === null ? defaultModel : models.find(({ id }) => id === model)

      if (model !== null && chosen === undefined)
        yield* new AgentError({
          message: `That place has no model "${model}". list_agent_options lists the models a place offers.`,
        })

      if (effort !== null && !(chosen?.efforts.includes(effort) ?? false))
        yield* new AgentError({
          message: `That model has no Effort "${effort}". list_agent_options lists each model's Efforts.`,
        })
    })

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
            agents: listed.map((agent) => ({
              agent,
              waiting: waiting.some((found) => found.agent.id === agent.id),
            })),
          })),
          Effect.mapError(explained),
        ),
      list_needs_you: () => first(needsYou.watch()).pipe(Effect.map((items) => ({ items }))),
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

          const material = pullRequestMaterial(yield* github.reviewInput(pullRequest, read))

          return { revision: read, ...material, ...withinBudget(material.files) }
        }).pipe(Effect.mapError(explained)),
      read_agent_review: ({ pullRequest }) =>
        first(agentReviews.watch(pullRequest)).pipe(Effect.mapError(explained)),
      start_agent_review: ({ pullRequest, revision }) =>
        agentReviews
          .start(pullRequest, revision)
          .pipe(
            Effect.uninterruptible,
            Effect.andThen(first(agentReviews.watch(pullRequest))),
            Effect.mapError(explained),
          ),
      list_agent_places: () =>
        Effect.gen(function* () {
          return {
            local: { engines: agents.engines(localPlace), localCheckouts: yield* checkouts.list() },
            sandboxProviders: sandboxes.providers,
            followedRepositories: yield* followed.list(),
          }
        }).pipe(Effect.mapError(explained)),
      list_agent_options: ({ place, repository, engine }) =>
        Effect.all(
          {
            defaultBranch: agents.newAgentDefaultBranch(place, repository),
            branches: agents.newAgentBranches(place, repository),
            models: agents.models(engine, place),
          },
          { concurrency: "unbounded" },
        ).pipe(Effect.mapError(explained)),
      create_agent: (input) =>
        Effect.gen(function* () {
          yield* refuseUnofferedModel(input)

          const agent = yield* agents
            .create({
              ...input,
              permissionMode: null,
              skillPacks: [],
              localSkills: false,
              images: [],
            })
            .pipe(Effect.uninterruptible)

          return { agent }
        }).pipe(Effect.mapError(explained)),
      send_agent_message: ({ agentId, message }) =>
        agents.send(agentId, { message, images: [] }).pipe(
          Effect.uninterruptible,
          Effect.map((delivery) => ({ delivery })),
          Effect.mapError(explained),
        ),
      ask_user: ({ question, choices, from, timeoutSeconds }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const caller = yield* McpCaller.current

            yield* Effect.forkScoped(waitingProgress)

            return yield* outsideQuestions.ask({
              question,
              choices: choices ?? [],
              session: caller.conversationId,
              label: from ?? null,
              timeout: Duration.seconds(timeoutSeconds ?? ASK_TIMEOUT_DEFAULT_SECONDS),
            })
          }),
        ),
    })
  }),
)
