import {
  ASK_USER_TOOL,
  AskedUser,
  AnswerState,
  CheckInStarted,
  ListedAnswer,
  type ActivityLogError,
  ActivityPage,
  Thread,
  AgentHarness,
  ThreadError,
  AgentModels,
  type AgentReviewFailure,
  AgentReviewState,
  Branches,
  type ThreadNotFound,
  type ConnectionError,
  FollowedRepository,
  type InvalidLocalCheckout,
  LocalCheckout,
  MessageDelivery,
  MessageText,
  InboxItems,
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
  ThreadPlace,
  localPlace,
} from "@glass/contracts"
import {
  Array as Arr,
  Context,
  DateTime,
  Effect,
  Match,
  Option,
  Order,
  Predicate,
  Schema,
  Stream,
} from "effect"
import { Tool, Toolkit } from "effect/ai"
import { ActivityLog } from "../ActivityLog"
import { AgentReviews } from "../AgentReviews"
import { PullRequestMaterial, pullRequestMaterial } from "../agentReviewPrompt"
import type { FileMaterial } from "../tourPrompt"
import { Threads } from "../Threads"
import { GitHubClient } from "../github/GitHubClient"
import { BackgroundGitHubRequest } from "../github/GitHubRequestPolicy"
import { FollowedRepositories } from "../FollowedRepositories"
import { LocalCheckouts } from "../LocalCheckouts"
import { CheckIns } from "../CheckIns"
import type { Caller } from "../callers"
import { McpCaller } from "./McpCredentials"
import { Inbox } from "../Inbox"
import { Questions } from "../Questions"
import { Sandboxes } from "../Sandboxes"
import { type Starter, StartedItem, StartedWork } from "../StartedWork"
import { PullRequestLists } from "../PullRequestLists"
import { Queue } from "../Queue"
import { ToDos } from "../ToDos"

export class GlassToolFailure extends Schema.TaggedError<GlassToolFailure>()("GlassToolFailure", {
  message: Schema.String,
}) {}

const MAX_ACTIVITY = 100

const MAX_TURNS = 20

const MAX_TEXT_CHARS = 4_000

const MAX_DIFF_CHARS = 60_000

export const readOnly = Context.make(Tool.Readonly, true).pipe(
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
  description:
    "Lists the user's To-dos in Glass, done or not, with their notes. An image is an id and a media type; its file stays on this device.",
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

const ListedThread = Schema.Struct({
  thread: Thread,
  waiting: Schema.Boolean.annotate({
    description:
      "Whether the Thread's agent is waiting for the user to answer a Question or Permission request.",
  }),
})

const ListThreads = Tool.make("list_threads", {
  description:
    "Lists the user's Threads, each with its repository, base branch, harness, and whether it waits for the user's answer.",
  success: Schema.Struct({ threads: Schema.Array(ListedThread) }),
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

const ListInbox = Tool.make("list_inbox", {
  description:
    "Lists the user's Glass Inbox: what waits on them now, in four groups in this order. Stopped on you: Threads with a Permission request or Question waiting, questions from an agent outside Glass, Check-ins, and the Global chat's own waiting requests. Agent reviews to read: queued PRs whose Agent review is finished. Your pull requests: the user's own PRs with changes requested, failing checks, Review threads awaiting their reply, or ready to merge. Threads that finished: Threads whose latest Turn ended since the user last looked. Within a group, the longest waiting comes first.",
  success: Schema.Struct({ items: InboxItems }),
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

const ListStartedWork = Tool.make("list_started_work", {
  description:
    "Lists the Threads and Agent reviews you started, or Threads you messaged, oldest first: each with its state now and the user's message that asked for it. Answer how the work you started is going from this, not from the chat. Threads and reviews the user started themselves, and deleted Threads, aren't listed.",
  success: Schema.Struct({ items: Schema.Array(StartedItem) }),
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

const TurnSummary = Schema.Struct({
  message: Schema.String,
  sentAt: Schema.DateTimeUtcFromString,
  ending: Schema.NullOr(TurnEnding).annotate({
    description: "How the Turn ended, or null while it runs.",
  }),
  activity: Schema.Array(Schema.String).annotate({
    description: "What its agent wrote and did in the Turn, in order, with long text cut short.",
  }),
})

const ReadThreadTranscript = Tool.make("read_thread_transcript", {
  description:
    "Reads a Thread's most recent Turns: each message the user sent, what its agent wrote and which tools it used, and how the Turn ended. Includes Queued messages not yet delivered.",
  parameters: Schema.Struct({
    threadId: Schema.String.annotate({
      description: "The Thread's id, from list_threads.",
    }),
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
    "Reads a PR's title, description, changed files with their diffs, and published comments at one Revision. Pass the Revision the user means, such as the one in a message's glass_context; leave it out to read the PR as it is now.",
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

const ListThreadPlaces = Tool.make("list_thread_places", {
  description:
    "Lists where the user can start a Thread. A Thread on this device works in a copy of a Local checkout, so its repository must be one of localCheckouts. A Thread in a Sandbox works in any followed repository, in a Sandbox from one of sandboxProviders. Each place runs only the Agent harnesses listed with it.",
  success: Schema.Struct({
    local: Schema.Struct({
      harnesses: Schema.Array(AgentHarness),
      localCheckouts: Schema.Array(LocalCheckout),
    }),
    sandboxProviders: Schema.Array(SandboxProviderInfo),
    followedRepositories: Schema.Array(FollowedRepository),
  }),
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

const ListThreadOptions = Tool.make("list_thread_options", {
  description:
    "Lists the base branches and models a Thread can start with, for a repository, place, and Agent harness from list_thread_places.",
  parameters: Schema.Struct({
    place: ThreadPlace,
    repository: FollowedRepository,
    harness: AgentHarness,
  }),
  success: Schema.Struct({
    ...Branches.fields,
    models: AgentModels,
  }),
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

export const acting = Context.make(Tool.Readonly, false).pipe(
  Context.add(Tool.Destructive, false),
  Context.add(Tool.Idempotent, false),
  Context.add(Tool.OpenWorld, false),
)

const CreateThread = Tool.make("create_thread", {
  description:
    "Creates a Thread: a named piece of work with a coding agent, on a branch of its own, made from a base branch of a repository. It starts its first Turn with the message, and appears in the user's Threads. This returns once Glass created the Thread, not when it finishes its Turn. When you are the Global chat or a Thread, Glass sends you an update when it finishes, fails, or waits on the user, so end your Turn rather than reading its transcript to wait; otherwise read_thread_transcript shows its progress. A Thread that creates one gives it its own Permission mode, and can't create one that asks the user less than it does, such as one in a Sandbox, unless it never asks either. A Thread in a Sandbox can only create Threads in a Sandbox. Choose the place, harness, base branch, and model from list_thread_places and list_thread_options, never from guesses. If this call fails without saying why, or is cut off, call list_threads before trying again rather than creating a second Thread.",
  parameters: Schema.Struct({
    repository: FollowedRepository,
    baseBranch: Schema.String.annotate({
      description: "The branch the Thread's branch starts from.",
    }),
    place: ThreadPlace.annotate({
      description:
        "Where the Thread's agent works: on this device, or in a Sandbox from a provider.",
    }),
    harness: AgentHarness.annotate({
      description: "The Agent harness that runs the Thread.",
    }),
    model: Schema.NullOr(Schema.String).annotate({
      description: "A model id from list_thread_options, or null for the harness's default.",
    }),
    effort: Schema.NullOr(Schema.String).annotate({
      description: "One of the model's Efforts, or null for its default.",
    }),
    message: MessageText.annotate({ description: "The Thread's first message: its task." }),
  }),
  success: Schema.Struct({ thread: Thread }),
  failure: GlassToolFailure,
}).annotateMerge(acting)

const SendThreadMessage = Tool.make("send_thread_message", {
  description:
    "Sends a message to one of the user's Threads, as the user would from the Thread. An idle Thread starts a Turn with it; a busy Thread keeps it as a Queued message and starts on it after its running Turn. This returns once Glass accepted the message, not when its agent answers. When you are the Global chat or a Thread, Glass sends you an update when it finishes, fails, or waits on the user, so end your Turn rather than reading its transcript to wait; otherwise read_thread_transcript shows its progress. A Thread can't message itself, or one that asks the user less than it does, and one in a Sandbox can only message Threads in a Sandbox. If this call fails without saying why, or is cut off, read the Thread's transcript before sending again rather than sending it twice.",
  parameters: Schema.Struct({
    threadId: Schema.String.annotate({
      description: "The Thread's id, from list_threads.",
    }),
    message: MessageText,
  }),
  success: Schema.Struct({
    delivery: MessageDelivery.annotate({
      description:
        "started: the Thread started a Turn with it. queued: it waits behind the running Turn.",
    }),
  }),
  failure: GlassToolFailure,
}).annotateMerge(acting)

const ReadAgentReview = Tool.make("read_agent_review", {
  description:
    "Reads a PR's Agent review: the latest one written, with the Revision it reviewed, and whether one is being written now or failed.",
  parameters: Schema.Struct({ pullRequest: PullRequestRef }),
  success: AgentReviewState,
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

const AskUser = Tool.make(ASK_USER_TOOL, {
  description:
    "Asks the user one question in the Glass Inbox and returns at once with its questionId; it doesn't wait for the answer. " +
    "Keep working on what doesn't depend on the answer; if nothing does, end your Turn. " +
    "A Thread or the Global chat that Glass launched gets the answer as a later message with a glass_answer block naming the questionId. " +
    "An agent outside Glass reads it with read_answer when it is ready for it. " +
    "The user picks one of the choices or types their own answer, or sets the question aside. Ask each question with its own call.",
  parameters: Schema.Struct({
    question: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)).annotate({
      description: "The question, as the user should read it in the Inbox.",
    }),
    choices: Schema.optional(
      Schema.Array(
        Schema.Struct({
          label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
          description: Schema.optional(
            Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(500)).annotate({
              description: "What picking this choice means, when the label alone doesn't say.",
            }),
          ),
        }),
      )
        .check(Schema.isMinLength(1), Schema.isMaxLength(8))
        .annotate({
          description:
            "Choices the user can pick, with distinct labels. They can still type their own answer. Omit this to ask for text only.",
        }),
    ),
  }),
  success: AskedUser,
  failure: GlassToolFailure,
}).annotateMerge(acting)

const ReadAnswer = Tool.make("read_answer", {
  description:
    "For an agent outside Glass: reads where a question you asked with ask_user, or a Check-in you made with check_in, stands, by its id, from any of your sessions. " +
    "Once you have read an answer, list_answers no longer lists it. " +
    "The result is Waiting while the user hasn't answered, or SetAside when they chose not to. " +
    "A question's answer is Answered (by is choice or text). " +
    "A Check-in's answer is Approved or Feedback, each with the user's optional message and their Feedback notes (a file path, the side of the diff, the line range, the code they read there, their note, and whether that code changed since); or Replaced, with the id of the Check-in that replaced it when you checked in again from the same folder. " +
    "Feedback asks you to change the code. Notes on an approval are guidance and ask for no more work.",
  parameters: Schema.Struct({
    id: Schema.String.annotate({
      description: "The questionId ask_user returned, or the checkInId check_in returned.",
    }),
  }),
  success: AnswerState,
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

const ListAnswers = Tool.make("list_answers", {
  description:
    "For an agent outside Glass: lists the questions you asked with ask_user and the Check-ins you made with check_in whose answer you haven't read yet, oldest first, from any of your sessions. " +
    "Each has its id and its state, as read_answer gives it: Waiting while the user hasn't answered, otherwise the answer. " +
    "Call it first in a new session, or when you have lost an id, to pick up the answers an earlier session asked for. " +
    "An answer listed here, or read with read_answer, isn't listed again; a Waiting one stays until it is answered and read.",
  success: Schema.Struct({ items: Schema.Array(ListedAnswer) }),
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

const CheckIn = Tool.make("check_in", {
  description:
    "For an agent outside Glass: asks the user to read the changes in a folder and approve them or send feedback in the Glass Inbox, under the name the user approved, and returns at once; it doesn't wait for their answer. " +
    "Pass the absolute path of your working directory. Glass reads the changes itself: the working tree, staged or not and including untracked files, against where the branch forked from baseRef, frozen as they are when you call. " +
    "The result is CheckedIn with the checkInId to pass read_answer when you are ready for the answer, or NoChanges when there is nothing to read. " +
    "Checking in again from the same folder replaces a Check-in the user hasn't answered, and the Feedback notes they left on it carry over.",
  parameters: Schema.Struct({
    folder: Schema.Trimmed.check(Schema.isNonEmpty()).annotate({
      description:
        "The absolute path of the folder whose changes to read, such as your working directory.",
    }),
    baseRef: Schema.optional(
      Schema.Trimmed.check(Schema.isNonEmpty()).annotate({
        description:
          "The branch or commit the changes started from. Defaults to the repository's default branch (origin/HEAD).",
      }),
    ),
    summary: Schema.optional(
      Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)).annotate({
        description:
          "Plain text on what changed and where to look. Its first line titles the Check-in in the Inbox.",
      }),
    ),
  }),
  success: CheckInStarted,
  failure: GlassToolFailure,
}).annotateMerge(acting)

const StartAgentReview = Tool.make("start_agent_review", {
  description:
    "Starts an Agent review of a PR at a Revision, as the user would from the PR. It appears beside the PR's diff once written. This returns once the review started, not when it is written, which takes minutes: read_agent_review shows its progress and result, or why it failed, such as the PR having changed since that Revision. Starting one replaces any review being written for the PR, so read_agent_review first and ask the user before replacing one. A review runs on this device and asks the user nothing, so a Thread can start one only when it is on this device and has no Permission mode.",
  parameters: Schema.Struct({
    pullRequest: PullRequestRef,
    revision: Revision.annotate({
      description: "The Revision to review, such as the one in a message's glass_context.",
    }),
  }),
  success: AgentReviewState,
  failure: GlassToolFailure,
}).annotateMerge(acting)

export const GlassTools = Toolkit.make(
  ListPullRequests,
  ListQueue,
  ListToDos,
  ListRecentActivity,
  ListThreads,
  ListInbox,
  ListStartedWork,
  ReadThreadTranscript,
  ReadPullRequest,
  ReadAgentReview,
  StartAgentReview,
  ListThreadPlaces,
  ListThreadOptions,
  CreateThread,
  SendThreadMessage,
  AskUser,
  ReadAnswer,
  ListAnswers,
  CheckIn,
)

type ServiceFailure =
  | ActivityLogError
  | ThreadError
  | AgentReviewFailure
  | ThreadNotFound
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
        ThreadNotFound: () =>
          "There's no Thread with that id. list_threads names the Threads there are.",
        InvalidLocalCheckout: ({ message }) =>
          `${message} The user links one from New Thread in Threads; a Thread in a Sandbox needs none.`,
        PullRequestAccessDenied: ({ message }) => message,
        GitHubUnavailable: ({ message }) => message,
        ActivityLogError: ({ message }) => message,
        ThreadError: ({ message }) => message,
        AgentReviewFailure: ({ message }) => message,
        RequestWaiting: () =>
          "The Thread's agent is waiting for the user to answer its Question or Permission request, so it took no message. The user answers it in the Thread.",
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

const dropLargestDiffsToFit = (files: ReadonlyArray<FileMaterial>) => {
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

const starterOf = (caller: Caller): Option.Option<Starter> =>
  Match.value(caller).pipe(
    Match.tagsExhaustive({
      GlobalChat: ({ globalChatId, sessionId }) =>
        Option.some({ startedBy: globalChatId, sessionId }),
      Thread: ({ threadId }) => Option.some({ startedBy: threadId, sessionId: threadId }),
      OutsideAgent: () => Option.none(),
    }),
  )

const recordedFor = <A, E, R, E2>(
  work: Effect.Effect<A, E, R>,
  record: (starter: Starter, since: DateTime.Utc, done: A) => Effect.Effect<void, E2>,
) =>
  Effect.gen(function* () {
    const since = yield* DateTime.now
    const done = yield* work
    const starter = starterOf(yield* McpCaller.current)

    if (Option.isSome(starter)) yield* record(starter.value, since, done).pipe(Effect.ignore)

    return done
  }).pipe(Effect.uninterruptible)

export const GlassToolHandlers = GlassTools.toLayer(
  Effect.gen(function* () {
    const lists = yield* PullRequestLists
    const queue = yield* Queue
    const toDos = yield* ToDos
    const activityLog = yield* ActivityLog
    const github = yield* GitHubClient
    const threads = yield* Threads
    const followed = yield* FollowedRepositories
    const checkouts = yield* LocalCheckouts
    const sandboxes = yield* Sandboxes
    const agentReviews = yield* AgentReviews
    const inbox = yield* Inbox
    const questions = yield* Questions
    const checkIns = yield* CheckIns
    const startedWork = yield* StartedWork

    const refuseUnofferedModel = Effect.fnUntraced(function* ({
      harness,
      place,
      model,
      effort,
    }: Tool.Parameters<typeof CreateThread>) {
      const { defaultModel, models } = yield* threads.models(harness, place)
      const chosen = model === null ? defaultModel : models.find(({ id }) => id === model)

      if (model !== null && chosen === undefined)
        yield* new ThreadError({
          message: `That place has no model "${model}". list_thread_options lists the models a place offers.`,
        })

      if (effort !== null && !(chosen?.efforts.includes(effort) ?? false))
        yield* new ThreadError({
          message: `That model has no Effort "${effort}". list_thread_options lists each model's Efforts.`,
        })
    })

    const callingThreadId = McpCaller.current.pipe(
      Effect.map((caller) =>
        Predicate.isTagged(caller, "Thread") ? Option.some(caller.threadId) : Option.none(),
      ),
    )

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
      list_threads: () =>
        Effect.all([first(threads.watch()), first(threads.watchWaiting())]).pipe(
          Effect.map(([listed, waiting]) => ({
            threads: listed.map((thread) => ({
              thread,
              waiting: waiting.some((found) => found.thread.id === thread.id),
            })),
          })),
          Effect.mapError(explained),
        ),
      list_inbox: () => first(inbox.watch()).pipe(Effect.map((items) => ({ items }))),
      list_started_work: () =>
        Effect.gen(function* () {
          const starter = starterOf(yield* McpCaller.current)

          if (Option.isNone(starter)) return { items: [] }

          const items = yield* startedWork
            .list(starter.value.startedBy)
            .pipe(Effect.mapError(explained))

          return {
            items: items.map((item) => ({
              ...item,
              askedWith: item.askedWith === null ? null : textOf(item.askedWith),
            })),
          }
        }),
      read_thread_transcript: ({ threadId, turns }) =>
        threads.readTranscript(threadId, turns).pipe(
          Effect.map((transcript) => ({
            turns: transcript.turns.map((turn) => ({
              message: textOf(turn.message),
              sentAt: turn.sentAt,
              ending: turn.ended?.ending ?? null,
              activity: activityOf(turn),
            })),
            earlierTurns: transcript.earlierTurns,
            queued: transcript.queued.map(({ message }) => textOf(message)),
          })),
          Effect.mapError(explained),
        ),
      read_pull_request: ({ pullRequest, revision }) =>
        Effect.gen(function* () {
          const input = yield* github.reviewInput(pullRequest, revision)
          const material = pullRequestMaterial(input)

          return { revision: input.revision, ...material, ...dropLargestDiffsToFit(material.files) }
        }).pipe(Effect.mapError(explained)),
      read_agent_review: ({ pullRequest }) =>
        first(agentReviews.watch(pullRequest)).pipe(Effect.mapError(explained)),
      start_agent_review: ({ pullRequest, revision }) =>
        Effect.gen(function* () {
          const starter = yield* callingThreadId

          if (Option.isSome(starter)) yield* threads.refuseReviewFrom(starter.value)

          yield* recordedFor(agentReviews.start(pullRequest, revision), (recorded, since) =>
            startedWork.startedAgentReview(recorded, pullRequest, since),
          )

          return yield* first(agentReviews.watch(pullRequest))
        }).pipe(Effect.mapError(explained)),
      list_thread_places: () =>
        Effect.gen(function* () {
          return {
            local: {
              harnesses: threads.harnesses(localPlace),
              localCheckouts: yield* checkouts.list(),
            },
            sandboxProviders: sandboxes.providers,
            followedRepositories: yield* followed.list(),
          }
        }).pipe(Effect.mapError(explained)),
      list_thread_options: ({ place, repository, harness }) =>
        Effect.all(
          {
            defaultBranch: threads.newThreadDefaultBranch(place, repository),
            branches: threads.newThreadBranches(place, repository),
            models: threads.models(harness, place),
          },
          { concurrency: "unbounded" },
        ).pipe(Effect.mapError(explained)),
      create_thread: (input) =>
        Effect.gen(function* () {
          yield* refuseUnofferedModel(input)

          const created = { ...input, skillPacks: [], localSkills: false, images: [] }
          const parent = yield* callingThreadId

          const thread = yield* recordedFor(
            Option.isSome(parent)
              ? threads.createFrom(parent.value, created)
              : threads.create({ ...created, permissionMode: null }),
            (starter, since, { id }) => startedWork.linkThread(starter, id, since),
          )

          return { thread }
        }).pipe(Effect.mapError(explained)),
      send_thread_message: ({ threadId, message }) =>
        callingThreadId.pipe(
          Effect.flatMap((sender) =>
            recordedFor(
              Option.isSome(sender)
                ? threads.sendFrom(sender.value, threadId, { message, images: [] })
                : threads.send(threadId, { message, images: [] }),
              (starter, since) => startedWork.linkThread(starter, threadId, since),
            ),
          ),
          Effect.map((delivery) => ({ delivery })),
          Effect.mapError(explained),
        ),
      ask_user: ({ question, choices }) =>
        Effect.gen(function* () {
          const offered = (choices ?? []).map(({ label, description }) => ({
            label,
            description: description ?? null,
          }))

          if (new Set(offered.map(({ label }) => label)).size !== offered.length)
            return yield* new GlassToolFailure({ message: "Give each choice its own label." })

          const asked = yield* questions.ask(yield* McpCaller.current, {
            question,
            choices: offered,
          })

          return { questionId: asked.id }
        }),
      read_answer: ({ id }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller.current

          if (!Predicate.isTagged(caller, "OutsideAgent"))
            return yield* new GlassToolFailure({
              message: "Glass sends a Thread its answers as messages; there's nothing to read.",
            })

          const question = yield* questions.readAnswer(id, caller.agentId)

          const state: Option.Option<typeof AnswerState.Type> = Option.isSome(question)
            ? question
            : yield* checkIns.readAnswer(id, caller.agentId)

          if (Option.isNone(state))
            return yield* new GlassToolFailure({
              message:
                "You asked no question and made no Check-in with that id. Pass the id ask_user or check_in returned.",
            })

          return state.value
        }),
      list_answers: () =>
        Effect.gen(function* () {
          const caller = yield* McpCaller.current

          if (!Predicate.isTagged(caller, "OutsideAgent"))
            return yield* new GlassToolFailure({
              message: "Glass sends a Thread its answers as messages; there's nothing to list.",
            })

          const [asked, checkedIn] = yield* Effect.all([
            questions.unread(caller.agentId),
            checkIns.unread(caller.agentId),
          ])

          return {
            items: Arr.sort(
              [...asked, ...checkedIn],
              Order.mapInput(
                DateTime.Order,
                ({ since }: { readonly since: DateTime.Utc }) => since,
              ),
            ),
          }
        }),
      check_in: ({ folder, baseRef, summary }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller.current

          if (!Predicate.isTagged(caller, "OutsideAgent"))
            return yield* new GlassToolFailure({
              message:
                "Only an agent outside Glass checks in. A Thread's changes are beside it already.",
            })

          return yield* checkIns
            .ask({
              folder,
              baseRef: baseRef ?? null,
              summary: summary ?? null,
              agentId: caller.agentId,
              askedBy: caller.name,
            })
            .pipe(Effect.mapError(({ message }) => new GlassToolFailure({ message })))
        }),
    })
  }),
)
