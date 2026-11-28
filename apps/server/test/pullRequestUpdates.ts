import {
  defaultSubscriptionKinds,
  EventPage,
  type EventKind,
  PullRequestRef,
  PullRequestSubject,
  SubscriptionSubject,
  type Turn,
} from "@glass/contracts"
import { Effect, Predicate, Schema } from "effect"
import { GlobalChatCaller } from "../src/mcp/McpCredentials"
import type { FakeCheck, FakePullRequest } from "./fakePullRequest"
import { connectMcp } from "./mcpClient"
import { glassCall, settled, type threadsFixture } from "./threadsFixture"
import { threadWithPullRequest } from "./threadWithPullRequest"

type Fixture = Effect.Success<typeof threadsFixture>

const decodePage = Schema.decodeUnknownSync(EventPage)

interface EventFilter {
  readonly pullRequest?: { readonly owner: string; readonly repo: string; readonly number: number }
  readonly since?: string
}

export const eventsTool = Effect.fnUntraced(function* ({
  baseUrl,
  mcpCredentials,
}: Pick<Fixture, "baseUrl" | "mcpCredentials">) {
  const mcp = yield* connectMcp(
    baseUrl,
    yield* mcpCredentials.issue(
      GlobalChatCaller.make({ globalChatId: "global-chat", sessionId: "global-session" }),
    ),
  )

  const page = (filter: EventFilter = {}) =>
    mcp
      .call("list_recent_events", { limit: 50, ...filter })
      .pipe(Effect.map((result) => decodePage(result.structuredContent)))

  return {
    page,
    events: (filter?: EventFilter) =>
      page(filter).pipe(Effect.map(({ events }) => events.map(({ event }) => event))),
  }
})

const encodeSubject = Schema.encodeSync(SubscriptionSubject)

export const subscribeArguments = (
  note: string,
  { owner, repo, number }: Pick<FakePullRequest, "owner" | "repo" | "number">,
  kinds: ReadonlyArray<EventKind> = defaultSubscriptionKinds,
) => ({
  subject: encodeSubject(
    PullRequestSubject.make({ pullRequest: new PullRequestRef({ owner, repo, number }) }),
  ),
  note,
  kinds,
})

export const subscribe = (
  note: string,
  pullRequest: Pick<FakePullRequest, "owner" | "repo" | "number">,
  kinds?: ReadonlyArray<EventKind>,
) => glassCall("subscribe", subscribeArguments(note, pullRequest, kinds))

export const subscribedThread = (note = "Keep it green", kinds?: ReadonlyArray<EventKind>) =>
  Effect.gen(function* () {
    const f = yield* threadWithPullRequest
    yield* f.send(f.thread.id, subscribe(note, f.pullRequest, kinds))
    yield* f.transcript(f.thread.id, settled(2))

    return f
  })

export const failed = (name: string, run = 1): FakeCheck => ({
  kind: "CheckRun",
  name,
  conclusion: "FAILURE",
  url: `https://ci.test/${name}/${run}`,
})

export const running = (name: string): FakeCheck => ({
  kind: "CheckRun",
  name,
  status: "IN_PROGRESS",
})

export const fail = (pullRequest: FakePullRequest, ...checks: ReadonlyArray<FakeCheck>) => {
  pullRequest.checks = "FAILURE"
  pullRequest.checkContexts = checks
}

export const pass = (pullRequest: FakePullRequest) => {
  pullRequest.checks = "SUCCESS"
  pullRequest.checkContexts = []
}

export const rerun = (pullRequest: FakePullRequest) => {
  pullRequest.checks = "PENDING"
  pullRequest.checkContexts = [running("lint")]
}

export const told = (turn: Turn | undefined) =>
  Predicate.isTagged(turn?.context, "Update")
    ? turn.context.subscriptions.flatMap(({ subject, note, events }) =>
        Predicate.isTagged(subject, "PullRequest")
          ? [
              {
                pullRequest: `${subject.pullRequest.repo}#${subject.pullRequest.number}`,
                note,
                events: events.map(({ event }) => event),
              },
            ]
          : [],
      )
    : undefined

export const kindsTold = (turn: Turn | undefined) =>
  told(turn)?.map(({ pullRequest, events }) => [pullRequest, events.map(({ _tag }) => _tag).join()])

export const failedRuns = (turn: Turn | undefined) =>
  told(turn)?.flatMap(({ events }) =>
    events.flatMap((event) =>
      Predicate.isTagged(event, "ChecksFailed") ? event.checks.map(({ url }) => url) : [],
    ),
  )

export const failThreeTimes = Effect.fnUntraced(function* (
  f: Pick<Fixture, "client" | "transcript"> & {
    readonly thread: { readonly id: string }
    readonly pullRequest: FakePullRequest
  },
) {
  for (const run of [1, 2, 3]) {
    fail(f.pullRequest, failed("lint", run))
    yield* f.client.ListPullRequests()
    yield* f.transcript(f.thread.id, settled(2 + run))
    rerun(f.pullRequest)
    yield* f.client.ListPullRequests()
  }
})
