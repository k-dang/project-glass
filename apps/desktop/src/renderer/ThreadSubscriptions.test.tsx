// @vitest-environment happy-dom
import {
  ChangesRequestedReason,
  ClosedReason,
  FailingChecksReason,
  MergeConflictReason,
  MergedReason,
  PullRequestOpen,
  PullRequestRef,
  PullRequestSubject,
  PullRequestUpdate,
  ReviewFeedbackReason,
  Subscription,
  TextPart,
  ThreadPullRequest,
  TranscriptSnapshot,
  TurnDone,
} from "@glass/contracts"
import { screen, waitFor, within } from "@testing-library/react"
import { DateTime, Effect, Stream, SubscriptionRef } from "effect"
import { expect, it } from "vite-plus/test"
import { thread } from "../../test/thread"
import { mount } from "../../test/threadApp"

const ownPullRequest = new ThreadPullRequest({
  threadId: thread.id,
  ref: new PullRequestRef({ owner: "glass-demo", repo: "greeter", number: 264 }),
  url: "https://github.com/glass-demo/greeter/pull/264",
  title: "Greet by name",
  state: PullRequestOpen.make({ checks: "passing" }),
})

const own = new Subscription({
  id: "own",
  threadId: thread.id,
  source: "github",
  subject: PullRequestSubject.make({ pullRequest: null }),
  reasons: ["failing-checks", "review-feedback", "changes-requested", "merge-conflict"],
  note: "Keep it green",
})

const dependency = new Subscription({
  id: "dependency",
  threadId: thread.id,
  source: "github",
  subject: PullRequestSubject.make({
    pullRequest: new PullRequestRef({ owner: "glass-demo", repo: "greeter", number: 7 }),
  }),
  reasons: ["merged-or-closed"],
  note: "Go on once it merges",
})

const mountSubscribed = (pullRequests: ReadonlyArray<ThreadPullRequest>) => {
  const subscriptions = Effect.runSync(SubscriptionRef.make([own, dependency]))

  const user = mount({
    WatchThreadPullRequests: () => Stream.make(pullRequests),
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    WatchSubscriptions: ({ threadId }) =>
      SubscriptionRef.changes(subscriptions).pipe(
        Stream.map((all) => all.filter((subscription) => subscription.threadId === threadId)),
      ),
    EndSubscription: ({ subscriptionId }) =>
      SubscriptionRef.update(subscriptions, (all) => all.filter(({ id }) => id !== subscriptionId)),
  })

  return user
}

const shownSubscriptions = async () => {
  const list = await screen.findByRole("list", { name: "Subscriptions" })

  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.textContent)
}

it("shows a Thread's Subscriptions in its details, each with its PR and what it covers", async () => {
  const user = mountSubscribed([ownPullRequest])

  await user.click(await screen.findByRole("button", { name: "Details" }))

  expect(await shownSubscriptions()).toEqual([
    "This Thread's PR #264failing checks, review feedback, changes requested, a merge conflict",
    "glass-demo/greeter#7merged or closed",
  ])
})

it("shows a Subscription to the Thread's own PR before that PR exists", async () => {
  const user = mountSubscribed([])

  await user.click(await screen.findByRole("button", { name: "Details" }))

  expect((await shownSubscriptions())[0]).toContain("This Thread's PR, once it has one")
})

it("ends a Subscription from the Thread's details", async () => {
  const user = mountSubscribed([ownPullRequest])
  await user.click(await screen.findByRole("button", { name: "Details" }))

  await user.click(
    await screen.findByRole("button", { name: "End the Subscription to glass-demo/greeter#7" }),
  )

  await waitFor(async () => expect(await shownSubscriptions()).toHaveLength(1))
  expect((await shownSubscriptions())[0]).toContain("This Thread's PR #264")
})

it("shows a PR update as a Turn Glass started, listing each PR and its reasons", async () => {
  const at = DateTime.makeUnsafe("2026-11-25T12:00:00Z")
  const comment = { id: "PRRC_1", author: "alice", body: "Rename this." }

  mount({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          turns: [
            {
              id: "update-1",
              message: "",
              images: [],
              context: PullRequestUpdate.make({
                source: "github",
                note: "Never merge a PR.",
                subjects: [
                  {
                    subscriptionId: own.id,
                    pullRequest: ownPullRequest.ref,
                    own: true,
                    note: own.note,
                    reasons: [
                      FailingChecksReason.make({
                        head: "h1",
                        checks: [
                          { name: "lint", url: "https://ci.test/lint/1" },
                          { name: "test", url: null },
                        ],
                      }),
                      ReviewFeedbackReason.make({
                        reviewThreads: [
                          { id: "PRRT_1", path: "src/greet.ts", line: 12, comments: [comment] },
                        ],
                      }),
                      ChangesRequestedReason.make({ reviewers: ["alice"] }),
                      MergeConflictReason.make({ base: "b0" }),
                    ],
                  },
                  {
                    subscriptionId: dependency.id,
                    pullRequest: dependency.subject.pullRequest!,
                    own: false,
                    note: dependency.note,
                    reasons: [MergedReason.make({})],
                  },
                  {
                    subscriptionId: "other",
                    pullRequest: new PullRequestRef({
                      owner: "glass-demo",
                      repo: "greeter",
                      number: 9,
                    }),
                    own: false,
                    note: "Stop once it closes",
                    reasons: [ClosedReason.make({})],
                  },
                ],
              }),
              feedback: [],
              sentAt: at,
              ended: { at, ending: TurnDone.make({}) },
              parts: [TextPart.make({ text: "Fixed lint and renamed it." })],
            },
          ],
          queued: [],
          status: null,
        }),
      ),
  })

  await screen.findByText("Fixed lint and renamed it.")
  const update = within(screen.getByRole("list", { name: "PR update from Glass" }))

  expect(update.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "glass-demo/greeter#264: 2 checks failed, 1 Review thread waits for a reply, alice requested changes, a merge conflict",
    "glass-demo/greeter#7: merged",
    "glass-demo/greeter#9: closed",
  ])
  expect(screen.queryByText("Rename this.")).toBeNull()
})
