import {
  type Activity,
  DraftsBlockReply,
  PublishedComment,
  type ReplyError,
  ReplySent,
} from "@glass/contracts"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { eventually } from "../../test/eventually"
import { ReplyStore } from "./useReplies"
import { type Held, hold, next, testRegistry } from "../../test/testBackend"
import { recordedPullRequest } from "../../test/workspace"

const replyStore = (unsent?: ReadonlyMap<string, string>) => {
  const replies: Array<
    Held<
      { readonly discussionId: string; readonly body: string },
      PublishedComment,
      typeof ReplyError.Type
    >
  > = []

  const recorded: Array<Activity> = []

  const store = new ReplyStore(
    testRegistry({ ReplyToDiscussion: hold(replies) }),
    recordedPullRequest,
    (activity) => {
      recorded.push(activity)
    },
    unsent,
  )

  return { store, replies, recorded }
}

const confirmed = new PublishedComment({
  id: "C2",
  author: "octocat",
  avatarUrl: null,
  bodyHtml: "<p>To greet them.</p>",
  createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
})

describe("ReplyStore", () => {
  it("publishes a Reply, then shows it among its Discussion's comments", async () => {
    const { store, replies } = replyStore()

    store.edit("T1", "To greet them.")
    store.send("T1")
    const reply = await next(replies)

    expect(reply.payload).toEqual({ discussionId: "T1", body: "To greet them." })
    expect(store.view("T1").feedback).toEqual({ type: "sending" })

    reply.answer(Effect.succeed(confirmed))

    await eventually(() =>
      expect(store.view("T1")).toEqual({ body: "", feedback: null, published: [confirmed] }),
    )
  })

  it("keeps a failed Reply's text until a retry publishes it, recording only the published one", async () => {
    const { store, replies, recorded } = replyStore()

    store.edit("T1", "To greet them.")
    store.send("T1")
    const failed = await next(replies)

    expect(failed.payload).toEqual({ discussionId: "T1", body: "To greet them." })

    failed.answer(Effect.fail(new DraftsBlockReply()))

    await eventually(() =>
      expect(store.view("T1")).toMatchObject({
        body: "To greet them.",
        feedback: { type: "failed" },
        published: [],
      }),
    )
    expect(recorded).toEqual([])

    store.send("T1")
    const retry = await next(replies)

    expect(retry.payload).toEqual({ discussionId: "T1", body: "To greet them." })
    expect(store.view("T1")).toEqual({
      body: "To greet them.",
      feedback: { type: "sending" },
      published: [],
    })

    retry.answer(Effect.succeed(confirmed))

    await eventually(() =>
      expect(store.view("T1")).toEqual({ body: "", feedback: null, published: [confirmed] }),
    )
    expect(recorded).toEqual([
      ReplySent.make({
        pullRequest: recordedPullRequest,
        discussionId: "T1",
        body: "To greet them.",
      }),
    ])
  })

  it("locks once Replies in flight land, leaving the text still unsent for the next load", async () => {
    const { store, replies } = replyStore(new Map([["T1", "Draft reply"]]))

    store.edit("T2", "To greet them.")
    store.send("T2")
    const reply = await next(replies)
    const locked = store.lock()
    let lockResolved = false

    void locked.then(() => {
      lockResolved = true
    })

    store.edit("T1", "Changed")
    store.send("T1")
    store.edit("T2", "Changed while sending")
    store.send("T2")

    await Promise.resolve()

    expect(lockResolved).toBe(false)
    expect(store.locked()).toBe(true)
    expect(store.view("T1")).toEqual({ body: "Draft reply", feedback: null, published: [] })
    expect(store.view("T2")).toEqual({
      body: "To greet them.",
      feedback: { type: "sending" },
      published: [],
    })
    expect(replies).toHaveLength(0)

    reply.answer(Effect.succeed(confirmed))

    expect(await locked).toEqual(new Map([["T1", "Draft reply"]]))
    expect(store.view("T2")).toEqual({ body: "", feedback: null, published: [confirmed] })

    store.edit("T1", "Changed after publishing")
    store.send("T1")
    store.edit("T2", "Another Reply")
    store.send("T2")

    expect(store.locked()).toBe(true)
    expect(store.view("T1")).toEqual({ body: "Draft reply", feedback: null, published: [] })
    expect(store.view("T2")).toEqual({ body: "", feedback: null, published: [confirmed] })
    expect(replies).toHaveLength(0)
  })
})
