// @vitest-environment happy-dom
import {
  PullRequestOpen,
  PullRequestRef,
  Subscription,
  ThreadPullRequest,
  TranscriptSnapshot,
} from "@glass/contracts"
import { screen, waitFor, within } from "@testing-library/react"
import { Effect, Stream, SubscriptionRef } from "effect"
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
  pullRequest: null,
  reasons: ["failing-checks", "review-feedback", "changes-requested", "merge-conflict"],
  note: "Keep it green",
})

const dependency = new Subscription({
  id: "dependency",
  threadId: thread.id,
  source: "github",
  pullRequest: new PullRequestRef({ owner: "glass-demo", repo: "greeter", number: 7 }),
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
