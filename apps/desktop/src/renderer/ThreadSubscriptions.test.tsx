// @vitest-environment happy-dom
import {
  ChangesRequestedEvent,
  ChecksFailedEvent,
  ChecksPassedEvent,
  type Event,
  LoggedEvent,
  MergeConflictEvent,
  PullRequestMergedEvent,
  PullRequestRef,
  PullRequestSubject,
  ReviewFeedbackEvent,
  Subscription,
  TextPart,
  TranscriptSnapshot,
  TurnDone,
  Update,
} from "@glass/contracts"
import { screen, waitFor, within } from "@testing-library/react"
import { DateTime, Effect, Stream, SubscriptionRef } from "effect"
import { expect, it } from "vite-plus/test"
import { thread } from "../../test/thread"
import { mount } from "../../test/threadApp"

const own = new PullRequestRef({ owner: "glass-demo", repo: "greeter", number: 264 })

const dependencyRef = new PullRequestRef({ owner: "glass-demo", repo: "greeter", number: 7 })

const ownSubscription = new Subscription({
  id: "own",
  subscriber: thread.id,
  source: "github",
  subject: PullRequestSubject.make({ pullRequest: own }),
  kinds: ["ChecksFailed", "ReviewFeedback", "ChangesRequested", "MergeConflict"],
  note: "Keep it green",
})

const dependency = new Subscription({
  id: "dependency",
  subscriber: thread.id,
  source: "github",
  subject: PullRequestSubject.make({ pullRequest: dependencyRef }),
  kinds: ["PullRequestMerged"],
  note: "Go on once it merges",
})

const mountSubscribed = () => {
  const subscriptions = Effect.runSync(SubscriptionRef.make([ownSubscription, dependency]))

  return mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    WatchSubscriptions: ({ threadId }) =>
      SubscriptionRef.changes(subscriptions).pipe(
        Stream.map((all) => all.filter((subscription) => subscription.subscriber === threadId)),
      ),
    EndSubscription: ({ subscriptionId }) =>
      SubscriptionRef.update(subscriptions, (all) => all.filter(({ id }) => id !== subscriptionId)),
  })
}

const shownSubscriptions = async () => {
  const list = await screen.findByRole("list", { name: "Subscriptions" })

  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.textContent)
}

it("shows a Thread's Subscriptions in its details, each with its PR and the kinds it asks for", async () => {
  const user = mountSubscribed()

  await user.click(await screen.findByRole("button", { name: "Details" }))

  expect(await shownSubscriptions()).toEqual([
    "glass-demo/greeter#264failing checks, review feedback, changes requested, a merge conflict",
    "glass-demo/greeter#7merged",
  ])
})

it("ends a Subscription from the Thread's details", async () => {
  const user = mountSubscribed()
  await user.click(await screen.findByRole("button", { name: "Details" }))

  await user.click(
    await screen.findByRole("button", { name: "End the Subscription to glass-demo/greeter#7" }),
  )

  await waitFor(async () => expect(await shownSubscriptions()).toHaveLength(1))
  expect((await shownSubscriptions())[0]).toContain("glass-demo/greeter#264")
})

it("shows an Update as a Turn Glass started, listing each PR and its Events", async () => {
  const at = DateTime.makeUnsafe("2026-11-25T12:00:00Z")
  const comment = { id: "PRRC_1", author: "alice", body: "Rename this." }

  const logged = (id: number, event: Event) =>
    new LoggedEvent({ id, source: "github", occurredAt: at, event })

  mount({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          turns: [
            {
              id: "update-1",
              message: "",
              images: [],
              context: Update.make({
                subscriptions: [
                  {
                    subscriptionId: ownSubscription.id,
                    subject: ownSubscription.subject,
                    note: ownSubscription.note,
                    events: [
                      logged(
                        1,
                        ChecksFailedEvent.make({
                          pullRequest: own,
                          head: "h1",
                          checks: [
                            { name: "lint", url: "https://ci.test/lint/1" },
                            { name: "test", url: null },
                          ],
                        }),
                      ),
                      logged(2, ChecksPassedEvent.make({ pullRequest: own, head: "h1" })),
                      logged(
                        3,
                        ReviewFeedbackEvent.make({
                          pullRequest: own,
                          reviewThreads: [
                            { id: "PRRT_1", path: "src/greet.ts", line: 12, comments: [comment] },
                          ],
                        }),
                      ),
                      logged(
                        4,
                        ChangesRequestedEvent.make({ pullRequest: own, reviewers: ["alice"] }),
                      ),
                      logged(5, MergeConflictEvent.make({ pullRequest: own, base: "b0" })),
                    ],
                  },
                  {
                    subscriptionId: dependency.id,
                    subject: dependency.subject,
                    note: dependency.note,
                    events: [
                      logged(
                        6,
                        PullRequestMergedEvent.make({ pullRequest: dependencyRef, mergedAt: at }),
                      ),
                    ],
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
  const update = within(screen.getByRole("list", { name: "Update from Glass" }))

  expect(update.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "glass-demo/greeter#264: 2 checks failed, checks passed, 1 Review thread waits for a reply, alice requested changes, a merge conflict",
    "glass-demo/greeter#7: merged",
  ])
  expect(screen.queryByText("Rename this.")).toBeNull()
})
