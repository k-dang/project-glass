// @vitest-environment happy-dom
import {
  ActivityPage,
  AllowRequest,
  Thread,
  ThreadChanges,
  InboxThread,
  ThreadPullRequest,
  type ThreadPullRequestState,
  DRAW_DIAGRAM_TOOL,
  AnswerQuestion,
  DenyRequest,
  Merge,
  AgentStatusesChanged,
  BackgroundWorkEnded,
  PermissionRequestPart,
  QuestionPart,
  type RequestAnswer,
  type Turn,
  type TurnPart,
  FollowedRepository,
  PartAppended,
  type BrowserPageAnswer,
  BrowserControl,
  BrowserPageReady,
  BrowserPageRequest,
  type PageEvent,
  type PageState,
  PageText,
  PartSet,
  PublishedComment,
  PullRequestRef,
  PullRequestMerged,
  PullRequestOpen,
  RemovalWarnings,
  type ResumableDestination,
  SandboxPlace,
  type SandboxReach,
  SandboxStatus,
  SavedPlace,
  ImageFile,
  TextFile,
  TextPart,
  ThinkingPart,
  ToDo,
  toDoMention,
  fileMention,
  ToolCallPart,
  ToolCallStatusSet,
  TranscriptSnapshot,
  TurnCutOff,
  TurnDone,
  TurnEnded,
  TurnFailed,
  TurnFinished,
  TurnStarted,
  TurnStopped,
  QueuedMessageStarted,
  UnsentFeedback,
  WaitingRequests,
  GitHubUnavailable,
} from "@glass/contracts"
import { cleanup, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DateTime, Deferred, Effect, Exit, Stream, SubscriptionRef } from "effect"
import { afterEach, expect, it, onTestFinished, vi } from "vite-plus/test"
import { thread, threadFields } from "../../test/thread"
import { changedFile, workspace } from "../../test/workspace"
import { modelOption, mount, pixel } from "../../test/threadApp"
import { BROWSER_PARTITION, PAGE_EVENT_CHANNEL } from "@glass/contracts/desktop"
import { threadFileAddress } from "./browserAddress"
import { agentHeldThreads, releaseBrowserPage } from "./browserPages"

const sentAt = DateTime.makeUnsafe("2026-10-26T12:00:00Z")

const attachPage = () => {
  const page = document.querySelector("webview")!

  const laidOut = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 800, 600))

  onTestFinished(() => laidOut.mockRestore())

  const loaded: Array<string> = []
  const toPage: Array<PageState> = []
  let reloads = 0

  Object.assign(page, {
    reload: () => void reloads++,
    loadURL: (url: string) => Promise.resolve(void loaded.push(url)),
    send: (_channel: string, state: PageState) => Promise.resolve(void toPage.push(state)),
    canGoBack: () => false,
    canGoForward: () => false,
    getURL: () => "about:blank",
    getTitle: () => "",
    getWebContentsId: () => 7,
    isWaitingForResponse: () => false,
  })
  page.dispatchEvent(new Event("dom-ready"))

  return {
    page,
    loaded,
    toPage,
    reloads: () => reloads,
    navigate: (url: string) =>
      page.dispatchEvent(Object.assign(new Event("did-navigate"), { url })),
    fromPage: (event: PageEvent) =>
      page.dispatchEvent(
        Object.assign(new Event("ipc-message"), { channel: PAGE_EVENT_CHANNEL, args: [event] }),
      ),
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()

  for (const threadId of agentHeldThreads()) releaseBrowserPage(threadId, "agent")
})

it("shows the Thread under Local and its Turn's parts as they stream", async () => {
  const turnId = "turn-1"

  mount({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({ turns: [], queued: [], status: null }),
        TurnStarted.make({
          turnId,
          message: "Run echo",
          images: [],
          context: null,
          feedback: [],
          sentAt,
        }),
        PartSet.make({ turnId, index: 0, part: ThinkingPart.make({ text: "I should " }) }),
        PartAppended.make({ turnId, index: 0, text: "run echo." }),
        PartSet.make({
          turnId,
          index: 1,
          part: ToolCallPart.make({
            toolCallId: "call-1",
            name: "bash",
            inputSummary: "echo hi",
            input: '{ "command": "echo hi" }',
            output: "hi",
            status: "done",
            parentToolCallId: null,
          }),
        }),
        PartSet.make({ turnId, index: 2, part: TextPart.make({ text: "It says hi." }) }),
        TurnEnded.make({
          turnId,
          ended: { at: DateTime.add(sentAt, { seconds: 3 }), ending: TurnDone.make({}) },
        }),
      ),
  })

  const list = await screen.findByRole("navigation", { name: "Threads list" })
  const onLocal = within(list).getByRole("region", { name: "Local" })
  expect(within(onLocal).getByRole("link", { name: thread.name })).toBeTruthy()

  const transcript = await screen.findByRole("region", { name: "Transcript" })
  expect(await within(transcript).findByText("It says hi.")).toBeTruthy()
  expect(within(transcript).getByText("Run echo")).toBeTruthy()
  expect(within(transcript).queryByRole("button", { name: "Thinking" })).toBeNull()

  const user = userEvent.setup()
  await user.click(
    within(transcript).getByRole("button", { name: "Worked · 1 tool call, 1 thought" }),
  )
  const thinking = await within(transcript).findByRole("button", { name: "Thinking" })
  expect(thinking.getAttribute("aria-expanded")).toBe("false")

  await user.click(thinking)
  expect(await within(transcript).findByText("I should run echo.")).toBeTruthy()

  const tool = within(transcript).getByRole("button", { name: "Done: bash echo hi" })
  await user.click(tool)
  expect(await within(transcript).findByText("hi")).toBeTruthy()
  expect(within(transcript).getByText("Done in 3s")).toBeTruthy()
})

it("shows a failed Turn's reason", async () => {
  const reason = "The process that runs Threads took too long to answer. Try again."

  mount({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          turns: [
            {
              id: "turn-1",
              message: "Build it",
              images: [],
              context: null,
              feedback: [],
              sentAt,
              parts: [],
              ended: {
                at: DateTime.add(sentAt, { seconds: 3 }),
                ending: TurnFailed.make({ reason }),
              },
            },
          ],
          queued: [],
          status: null,
        }),
      ),
  })

  const failed = await screen.findByRole("alert")
  expect(failed.textContent).toBe(`Failed after 3s: ${reason}`)
})

it("marks the finished Turn seen once Glass is focused on the Thread's Chat", async () => {
  const focused = vi.spyOn(document, "hasFocus").mockReturnValue(false)
  const seen: Array<{ threadId: string; endedAt: string }> = []
  const endedAt = DateTime.add(sentAt, { seconds: 3 })

  mount({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          turns: [
            {
              id: "turn-1",
              message: "Run echo",
              images: [],
              context: null,
              feedback: [],
              sentAt,
              parts: [TextPart.make({ text: "It says hi." })],
              ended: { at: endedAt, ending: TurnDone.make({}) },
            },
          ],
          queued: [],
          status: null,
        }),
      ),
    MarkTurnSeen: ({ threadId, endedAt: at }) =>
      Effect.sync(() => void seen.push({ threadId, endedAt: DateTime.formatIso(at) })),
  })

  expect(await screen.findByText("It says hi.")).toBeTruthy()
  expect(seen).toEqual([])

  focused.mockReturnValue(true)
  window.dispatchEvent(new Event("focus"))

  await waitFor(() =>
    expect(seen).toEqual([{ threadId: thread.id, endedAt: DateTime.formatIso(endedAt) }]),
  )
  focused.mockRestore()
})

it("marks a Thread in the Threads panel as working while its Turn runs", async () => {
  mount({ WatchWorkingThreads: () => Stream.make([thread.id]) }, "/threads")

  expect(
    await screen.findByRole("link", { name: thread.name, description: /Working/ }),
  ).toBeTruthy()
})

it("lists Settled Threads apart from the ones still going, in a section that starts collapsed", async () => {
  const broughtBack: Array<string> = []

  mount(
    {
      WatchSettledThreads: () => Stream.make([thread.id]),
      BringBackThread: ({ threadId }) => Effect.sync(() => void broughtBack.push(threadId)),
    },
    "/threads",
  )

  const settled = await screen.findByRole("region", { name: "Settled" })

  expect(within(settled).queryByRole("link")).toBeNull()
  expect(screen.queryByRole("region", { name: "Local" })).toBeNull()

  const user = userEvent.setup()
  const toggle = within(settled).getByRole("button", { name: "Settled 1" })
  await user.click(toggle)
  expect(await within(settled).findByRole("link", { name: thread.name })).toBeTruthy()

  await user.click(toggle)
  await waitFor(() => expect(within(settled).queryByRole("link")).toBeNull())

  await user.click(toggle)

  await user.click(
    await within(settled).findByRole("button", { name: `Bring back ${thread.name}` }),
  )
  await waitFor(() => expect(broughtBack).toEqual([thread.id]))
})

it("removes every Settled Thread without uncommitted changes at once", async () => {
  const clean = new Thread({ ...threadFields, id: "agent-2", name: "agent/calm-heron" })
  const removed: Array<string> = []

  const user = mount(
    {
      WatchThreads: () => Stream.make([thread, clean]),
      WatchSettledThreads: () => Stream.make([thread.id, clean.id]),
      GetRemovalWarnings: ({ threadId }) =>
        Effect.succeed(
          new RemovalWarnings({
            uncommittedChanges: threadId === clean.id ? "none" : "some",
          }),
        ),
      RemoveThread: ({ threadId }) => Effect.sync(() => void removed.push(threadId)),
    },
    "/threads",
  )

  await user.click(await screen.findByRole("button", { name: "Remove Settled Threads" }))

  const dialog = await screen.findByRole("alertdialog", {
    name: "Remove 2 Settled Threads?",
  })

  await user.click(within(dialog).getByRole("button", { name: "Remove Threads" }))

  await waitFor(() => expect(removed).toEqual([clean.id]))
})

it("says in the Threads panel how a Turn that finished unseen ended", async () => {
  const ended = {
    at: DateTime.add(sentAt, { seconds: 3 }),
    ending: TurnFailed.make({ reason: "Out of tokens" }),
  }

  mount(
    {
      WatchInbox: () =>
        Stream.make([
          InboxThread.make({
            thread,
            reasons: [TurnFinished.make({ ended })],
            since: ended.at,
          }),
        ]),
    },
    "/threads",
  )

  expect(await screen.findByRole("link", { name: thread.name, description: /Failed/ })).toBeTruthy()
})

it("shows the statuses the Thread's extensions set while no Turn runs, until they clear", async () => {
  const cleared = Deferred.makeUnsafe<void>()

  mount({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          turns: [],
          queued: [],
          status: null,
          agentStatuses: ["Explore: Trace composer to harness"],
        }),
      ).pipe(
        Stream.concat(
          Stream.fromEffect(
            Deferred.await(cleared).pipe(
              Effect.as(AgentStatusesChanged.make({ agentStatuses: [] })),
            ),
          ),
        ),
      ),
  })

  const statuses = await screen.findByRole("status", { name: "Agent statuses" })
  expect(within(statuses).getByText("Explore: Trace composer to harness")).toBeTruthy()

  Deferred.doneUnsafe(cleared, Exit.void)
  await waitFor(() => expect(screen.queryByRole("status", { name: "Agent statuses" })).toBeNull())
})

it("sends a message with Enter and clears the composer", async () => {
  const sent: Array<string> = []

  const user = mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    SendMessage: ({ message }) => Effect.sync(() => void sent.push(message)),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await user.type(composer, "Add a test{Shift>}{Enter}{/Shift}for it{Enter}")

  expect(sent).toEqual(["Add a test\nfor it"])
  expect(composer).toHaveProperty("textContent", "")
})

it("switches between Chat and Changes with Mod+D, even from the composer", async () => {
  const user = mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    GetThreadChanges: () => Effect.succeed(new ThreadChanges({ id: "read", files: [] })),
  })

  await user.click(await screen.findByRole("textbox", { name: "Message" }))
  await user.keyboard("{Control>}d{/Control}")
  await screen.findByRole("region", { name: "Changes" })

  await user.keyboard("{Meta>}d{/Meta}")
  await screen.findByRole("textbox", { name: "Message" })
  expect(screen.queryByRole("region", { name: "Changes" })).toBeNull()
})

it("sends Markdown and HTML exactly as written", async () => {
  const sent: Array<string> = []

  const user = mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    SendMessage: ({ message }) => Effect.sync(() => void sent.push(message)),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await user.type(composer, "Rename `foo_bar` in **<App>** *now*{Enter}")

  expect(sent).toEqual(["Rename `foo_bar` in **<App>** *now*"])
})

it("opens a Follow-up Thread and keeps it out of the Threads list", async () => {
  const reviewThread = new Thread({
    ...threadFields,
    id: "review-agent",
    name: "agent/review-hare",
    forReview: true,
  })

  mount(
    {
      WatchThreads: () => Stream.make([thread, reviewThread]),
      WatchTranscript: () =>
        Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    },
    "/threads/review-agent",
  )

  expect(await screen.findByRole("heading", { name: reviewThread.name })).toBeTruthy()
  expect(
    screen.queryByText("This Thread is gone. Pick another Thread or start a new one."),
  ).toBeNull()
  expect(screen.queryByRole("link", { name: reviewThread.name })).toBeNull()
  expect(screen.getByRole("link", { name: thread.name })).toBeTruthy()
})

const filedPullRequest = (pullRequestUrl: string) =>
  TranscriptSnapshot.make({
    turns: [
      {
        id: "turn-1",
        message: "File the PR",
        images: [],
        context: null,
        feedback: [],
        sentAt,
        parts: [TextPart.make({ text: `I filed the PR: ${pullRequestUrl}` })],
        ended: { at: sentAt, ending: TurnDone.make({}) },
      },
    ],
    queued: [],
    status: null,
  })

it("opens a PR the agent links to in a pane beside the chat, with its comments, its diffs and its review", async () => {
  const pullRequestUrl = "https://github.com/octo-org/hello-world/pull/42"

  const user = mount({
    LoadPullRequest: () =>
      Effect.succeed(
        workspace([], {
          files: [changedFile("greet.ts")],
          timeline: [
            new PublishedComment({
              id: "C1",
              author: "hubot",
              avatarUrl: null,
              bodyHtml: "<p>Ship it after the rename.</p>",
              createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
              reactions: [],
            }),
          ],
        }),
      ),
    WatchTranscript: () => Stream.make(filedPullRequest(pullRequestUrl)),
  })

  const link = await screen.findByRole("link", { name: pullRequestUrl })
  const threadHash = window.location.hash
  await user.click(link)

  const pane = await screen.findByRole("complementary", { name: "Pull request" })
  expect(await within(pane).findByText("Greet the world")).toBeTruthy()
  expect(window.location.hash).toBe(threadHash)
  expect(within(pane).getByText("Ship it after the rename.")).toBeTruthy()

  await user.click(within(pane).getByRole("tab", { name: "Code" }))
  expect(await within(pane).findByRole("button", { name: "Hide greet.ts" })).toBeTruthy()

  await user.click(within(pane).getByRole("button", { name: "Open review" }))

  await waitFor(() => expect(window.location.hash).toBe("#/reviews/octo-org/hello-world/42"))
})

it("shows the PR as merged after merging it from the pane", async () => {
  const pullRequestUrl = "https://github.com/octo-org/hello-world/pull/42"
  const loads: Array<number> = []

  const user = mount({
    LoadPullRequest: () =>
      Effect.sync(() => {
        loads.push(loads.length)

        return loads.length === 1
          ? workspace([], { pullRequest: { mergeAction: Merge.make({ method: "squash" }) } })
          : workspace([], { pullRequest: { state: "merged" } })
      }),
    MergePullRequest: () => Effect.void,
    WatchTranscript: () => Stream.make(filedPullRequest(pullRequestUrl)),
  })

  await user.click(await screen.findByRole("link", { name: pullRequestUrl }))
  const pane = await screen.findByRole("complementary", { name: "Pull request" })
  expect(await within(pane).findByText("No conflicts")).toBeTruthy()
  await user.click(within(pane).getByRole("button", { name: "Merge" }))

  await waitFor(() => expect(within(pane).queryByText("No conflicts")).toBeNull())
  expect(within(pane).getByText("Greet the world")).toBeTruthy()
  expect(loads).toHaveLength(2)
})

it("shows the PR as it is on GitHub now after reloading the pane", async () => {
  const pullRequestUrl = "https://github.com/octo-org/hello-world/pull/42"
  let loads = 0

  const user = mount({
    LoadPullRequest: () =>
      Effect.sync(() => {
        loads += 1

        return workspace([], {
          pullRequest: { title: loads === 1 ? "Greet the world" : "Greet everyone" },
        })
      }),
    WatchTranscript: () => Stream.make(filedPullRequest(pullRequestUrl)),
  })

  await user.click(await screen.findByRole("link", { name: pullRequestUrl }))
  const pane = await screen.findByRole("complementary", { name: "Pull request" })
  expect(await within(pane).findByText("Greet the world")).toBeTruthy()
  await user.click(within(pane).getByRole("button", { name: "Reload" }))

  expect(await within(pane).findByText("Greet everyone")).toBeTruthy()
})

it("keeps the hidden panel recoverable across Thread navigation", async () => {
  const user = mount(
    {
      WatchTranscript: () =>
        Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    },
    "/threads/missing",
  )

  await screen.findByText("This Thread is gone. Pick another Thread or start a new one.")
  const panel = screen.getByRole("complementary", { name: "Threads panel" })
  await user.click(screen.getByRole("button", { name: "Hide Threads panel" }))

  expect(panel).toHaveProperty("hidden", true)
  expect(screen.queryByRole("navigation", { name: "Threads list" })).toBeNull()
  const toggle = screen.getByRole("button", { name: "Show Threads panel" })
  expect(toggle.getAttribute("aria-controls")).toBe(panel.id)
  expect(toggle.getAttribute("aria-expanded")).toBe("false")

  await user.keyboard("{Control>}n{/Control}")
  await screen.findByRole("region", { name: "New Thread" })
  expect(screen.getByRole("button", { name: "Show Threads panel" })).toBeTruthy()

  await user.keyboard("{Control>}b{/Control}")
  const link = await screen.findByRole("link", { name: thread.name })
  link.focus()
  await user.keyboard("{Meta>}b{/Meta}")
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show Threads panel" }))

  await user.keyboard(" ")
  expect(screen.getByRole("link", { name: thread.name })).toBeTruthy()
})

it("removes the open Thread from the sidebar after confirming its uncommitted changes", async () => {
  const removed: Array<string> = []

  const user = mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    GetRemovalWarnings: () => Effect.succeed(new RemovalWarnings({ uncommittedChanges: "some" })),
    RemoveThread: ({ threadId }) => Effect.sync(() => void removed.push(threadId)),
  })

  await user.click(await screen.findByRole("button", { name: "Remove agent/swift-otter" }))
  const dialog = await screen.findByRole("alertdialog", { name: "Remove agent/swift-otter?" })
  await user.click(within(dialog).getByRole("button", { name: "Remove Thread" }))

  await waitFor(() => expect(removed).toEqual([thread.id]))
  expect(window.location.hash).toBe("#/threads/new")
})

it("shows the Skill packs and commits a Thread was created with, and its Local skills, in its details", async () => {
  const user = mount({
    WatchThreads: () =>
      Stream.make([
        new Thread({
          ...threadFields,
          place: SandboxPlace.make({ providerId: "fake" }),
          skillPacks: [{ name: "team", commit: "ae5650fbbbb" }],
          localSkills: true,
        }),
      ]),
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
  })

  await user.click(await screen.findByRole("button", { name: "Details" }))

  expect(await screen.findByText("team @ ae5650f · Local skills")).toBeTruthy()
})

it("starts loading a PR the agent links to on hover and opens its pane from that load", async () => {
  const pullRequestUrl = "https://github.com/octo-org/hello-world/pull/42"
  const loads: Array<PullRequestRef> = []

  const user = mount({
    LoadPullRequest: ({ pullRequest }) => {
      loads.push(pullRequest)

      return Effect.succeed(workspace())
    },
    WatchTranscript: () => Stream.make(filedPullRequest(pullRequestUrl)),
  })

  const link = await screen.findByRole("link", { name: pullRequestUrl })
  await user.hover(link)
  await waitFor(() =>
    expect(loads).toEqual([
      new PullRequestRef({ owner: "octo-org", repo: "hello-world", number: 42 }),
    ]),
  )

  await user.click(link)

  const pane = await screen.findByRole("complementary", { name: "Pull request" })
  expect(await within(pane).findByText("Greet the world")).toBeTruthy()
  expect(loads).toHaveLength(1)
})

const threadPullRequest = (state: ThreadPullRequestState) =>
  new ThreadPullRequest({
    threadId: thread.id,
    ref: new PullRequestRef({ owner: "glass-demo", repo: "greeter", number: 264 }),
    url: "https://github.com/glass-demo/greeter/pull/264",
    title: "Greet by name",
    state,
  })

it("links the Thread's PR from its header, its details, and its row in the list", async () => {
  const pullRequest = threadPullRequest(PullRequestOpen.make({ checks: "passing" }))
  const loads: Array<PullRequestRef> = []

  const user = mount({
    LoadPullRequest: (payload) => {
      loads.push(payload.pullRequest)

      return Effect.succeed(workspace())
    },
    WatchThreads: () => Stream.make([thread]),
    WatchThreadPullRequests: () => Stream.make([pullRequest]),
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
  })

  const headerLink = await screen.findByRole("link", { name: "Open PR #264, checks passing" })
  expect(headerLink.getAttribute("href")).toBe(pullRequest.url)
  await waitFor(() => expect(loads).toEqual([pullRequest.ref]))
  expect(
    screen.getByRole("link", { name: thread.name, description: /PR #264, checks passing/ }),
  ).toBeTruthy()

  await user.click(screen.getByRole("button", { name: "Details" }))

  const detailsLink = await screen.findByRole("link", { name: /Greet by name/ })
  expect(detailsLink.getAttribute("href")).toBe(pullRequest.url)

  await user.click(detailsLink)

  const pane = await screen.findByRole("complementary", { name: "Pull request" })
  expect(await within(pane).findByText("Greet the world")).toBeTruthy()
  expect(loads).toHaveLength(1)
})

it("loads the Thread's PR again when its pane opens after the early load failed", async () => {
  const pullRequest = threadPullRequest(PullRequestOpen.make({ checks: "passing" }))
  let loads = 0

  const user = mount({
    LoadPullRequest: () => {
      loads += 1

      return loads === 1
        ? Effect.fail(new GitHubUnavailable({ message: "Try again later." }))
        : Effect.succeed(workspace())
    },
    WatchThreads: () => Stream.make([thread]),
    WatchThreadPullRequests: () => Stream.make([pullRequest]),
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
  })

  await waitFor(() => expect(loads).toBe(1))
  await user.click(await screen.findByRole("link", { name: "Open PR #264, checks passing" }))

  const pane = await screen.findByRole("complementary", { name: "Pull request" })
  expect(await within(pane).findByText("Greet the world")).toBeTruthy()
})

it("tells the user the Thread's PR merged, in its header and its row in the list", async () => {
  mount({
    WatchThreads: () => Stream.make([thread]),
    WatchThreadPullRequests: () =>
      Stream.make([threadPullRequest(PullRequestMerged.make({ mergedAt: sentAt }))]),
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
  })

  expect(await screen.findByRole("link", { name: "Open PR #264, merged" })).toBeTruthy()
  expect(
    screen.getByRole("link", { name: thread.name, description: /PR #264, merged/ }),
  ).toBeTruthy()
})

const diagramTranscript = () =>
  Stream.make(
    TranscriptSnapshot.make({
      queued: [],
      status: null,
      turns: [
        {
          id: "turn-1",
          message: "Draw a diagram",
          images: [],
          context: null,
          feedback: [],
          sentAt,
          ended: { at: sentAt, ending: TurnDone.make({}) },
          parts: [
            ToolCallPart.make({
              toolCallId: "draw-1",
              name: DRAW_DIAGRAM_TOOL,
              inputSummary: "Component map",
              input: JSON.stringify({
                title: "Component map",
                kind: "existing",
                mermaid: "flowchart LR\n  A --> B",
              }),
              output: null,
              status: "done",
              parentToolCallId: null,
            }),
          ],
        },
      ],
    }),
  )

it("opens a Diagram from the Thread's details, without scrolling back to its card", async () => {
  const user = mount({
    WatchTranscript: diagramTranscript,
  })

  await user.click(await screen.findByRole("button", { name: "Details" }))
  await user.click(await screen.findByRole("button", { name: "Component map" }))

  const pane = await screen.findByRole("complementary", { name: "Diagram" })
  expect(within(pane).getByText("Component map")).toBeTruthy()
})

it("keeps a Thread as the user left it when they come back to it from another Thread or a New Thread", async () => {
  const other = new Thread({ ...threadFields, id: "agent-2", name: "agent/calm-heron" })

  const user = mount({
    WatchThreads: () => Stream.make([thread, other]),
    WatchTranscript: diagramTranscript,
  })

  await user.type(
    (await screen.findByRole("textbox", { name: "Message" })).firstElementChild!,
    "Half",
  )
  await user.click(screen.getByRole("button", { name: "Details" }))
  await user.click(await screen.findByRole("button", { name: "Component map" }))
  await screen.findByRole("complementary", { name: "Diagram" })

  await user.click(screen.getByRole("link", { name: other.name }))
  await screen.findByRole("heading", { name: other.name })
  expect(screen.queryByRole("complementary", { name: "Diagram" })).toBeNull()

  await user.click(screen.getByRole("link", { name: thread.name }))
  expect(await screen.findByRole("complementary", { name: "Diagram" })).toBeTruthy()

  await user.click(screen.getByRole("link", { name: "New Thread" }))
  await screen.findByRole("region", { name: "New Thread" })
  await user.click(screen.getByRole("link", { name: thread.name }))
  expect(await screen.findByRole("complementary", { name: "Diagram" })).toBeTruthy()

  const composer = screen.getByRole("textbox", { name: "Message" })
  await user.type(composer.firstElementChild!, " a thought")
  expect(composer.textContent).toBe("Half a thought")
})

it("floats a Thread's details over its chat on a wide window, until the user hides them", async () => {
  const { happyDOM } = window
  const width = window.innerWidth

  happyDOM.setViewport({ width: 1400 })
  onTestFinished(() => happyDOM.setViewport({ width }))

  const user = mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
  })

  const details = await screen.findByRole("complementary", { name: "Details" })
  await user.click(within(details).getByRole("button", { name: /Changes/ }))

  expect(await screen.findByRole("heading", { name: "Changes" })).toBeTruthy()
  expect(screen.queryByRole("complementary", { name: "Details" })).toBeNull()

  await user.click(screen.getByRole("button", { name: "Details" }))
  await user.click(await screen.findByRole("button", { name: /Back to Chat/ }))
  await user.click(await screen.findByRole("button", { name: "Hide details" }))

  expect(screen.queryByRole("complementary", { name: "Details" })).toBeNull()
})

it("lists a Sandbox Thread's commands again once its Sandbox can be reached", async () => {
  const reached = Deferred.makeUnsafe<void>()
  let made = false

  const user = mount({
    WatchThreads: () =>
      Stream.concat(
        Stream.make([inSandboxWith("connecting")]),
        Stream.fromEffect(Deferred.await(reached)).pipe(Stream.as([inSandboxWith("reachable")])),
      ),
    ListThreadCommands: () =>
      Effect.sync(() =>
        made ? [{ name: "local:grilling", description: "Ask hard questions." }] : [],
      ),
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await user.type(composer, "/")
  expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull()

  made = true
  Deferred.doneUnsafe(reached, Exit.void)
  await user.type(composer, "{Backspace}/gr")

  expect(
    within(await screen.findByRole("listbox", { name: "Commands" })).getByRole("option")
      .textContent,
  ).toBe("/local:grillingAsk hard questions.")
})

it("lists a Sandbox Thread under Sandboxes, and shows the step its Sandbox is at while it's made", async () => {
  const inSandbox = new Thread({
    ...threadFields,
    id: "agent-2",
    name: "agent/calm-heron",
    place: SandboxPlace.make({ providerId: "fake" }),
    harness: "claude-code",
    permissionMode: "bypassPermissions",
  })

  const onLamp = new Thread({
    ...threadFields,
    id: "agent-3",
    name: "agent/quick-wren",
    repository: new FollowedRepository({ owner: "glass-demo", repo: "lamp" }),
  })

  const later = new Thread({ ...threadFields, id: "agent-4", name: "agent/slow-newt" })

  mount(
    {
      WatchThreads: () => Stream.make([inSandbox, thread, onLamp, later]),
      WatchTranscript: () =>
        Stream.make(
          TranscriptSnapshot.make({
            turns: [runningTurn],
            queued: [],
            status: "Cloning the repository",
          }),
        ),
    },
    `/threads/${inSandbox.id}`,
  )

  const list = await screen.findByRole("navigation", { name: "Threads list" })
  const sections = within(list).getAllByRole("region")
  expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual([
    "Local",
    "Sandboxes",
  ])
  expect(
    within(sections[0]!)
      .getAllByRole("link")
      .map((link) => link.getAttribute("aria-label")),
  ).toEqual([thread.name, later.name, onLamp.name])
  expect(within(sections[1]!).getByRole("link", { name: inSandbox.name })).toBeTruthy()

  const transcript = await screen.findByRole("region", { name: "Transcript" })
  expect(await within(transcript).findByText("Cloning the repository…")).toBeTruthy()
  await screen.findByRole("button", { name: "Claude Code: Opus 5.5" })
  expect(screen.queryByRole("combobox", { name: "Permission mode" })).toBeNull()
})

it("changes the open Thread's model from the composer, closing the picker", async () => {
  const changes: Array<{ model: string | null; effort: string | null }> = []

  const user = mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    ChangeThreadModel: ({ model, effort }) =>
      Effect.sync(() => changes.push({ model, effort })).pipe(
        Effect.as(new Thread({ ...threadFields, model, effort })),
      ),
  })

  await user.click(await screen.findByRole("button", { name: "pi: gpt-test" }))
  await user.click(await modelOption("Thinker"))

  expect(changes).toEqual([{ model: "glass-test/thinker", effort: null }])
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
})

const call = (toolCallId: string, name: string, parentToolCallId: string | null) =>
  ToolCallPart.make({
    toolCallId,
    name,
    inputSummary: toolCallId,
    input: "{}",
    output: "ok",
    status: "done",
    parentToolCallId,
  })

it("nests a subagent's tool calls under the tool call that started it", async () => {
  const turnId = "turn-1"

  const user = mount({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          queued: [],
          status: null,
          turns: [
            {
              id: turnId,
              message: "Delegate",
              images: [],
              context: null,
              feedback: [],
              sentAt,
              ended: null,
              parts: [call("task-1", "Agent", null), call("bash-1", "Bash", "task-1")],
            },
          ],
        }),
      ),
  })

  const transcript = await screen.findByRole("region", { name: "Transcript" })
  const parent = await within(transcript).findByRole("button", { name: "Done: Agent task-1" })
  expect(within(transcript).queryByRole("button", { name: "Done: Bash bash-1" })).toBeNull()

  await user.click(parent)
  expect(await within(transcript).findByRole("button", { name: "Done: Bash bash-1" })).toBeTruthy()
})

it("folds a run of steps into one line naming the tool call still running", async () => {
  mount({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          queued: [],
          status: null,
          turns: [
            {
              id: "turn-1",
              message: "Fix it",
              images: [],
              context: null,
              feedback: [],
              sentAt,
              ended: null,
              parts: [
                ThinkingPart.make({ text: "Look first." }),
                call("read-1", "Read", null),
                ToolCallPart.make({ ...call("bash-1", "Bash", null), status: "failed" }),
                ToolCallPart.make({ ...call("bash-2", "Bash", null), status: "running" }),
              ],
            },
          ],
        }),
      ),
  })

  const transcript = await screen.findByRole("region", { name: "Transcript" })
  expect(
    await within(transcript).findByRole("button", {
      name: "Running Bash · 3 tool calls, 1 thought, 1 failed",
    }),
  ).toBeTruthy()
  expect(within(transcript).queryByRole("button", { name: "Done: Read read-1" })).toBeNull()
})

it("shows a replied Turn still running while its background work runs", async () => {
  mount({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          queued: [],
          status: null,
          agentStatuses: ["Running a command: Run the tests"],
          backgroundToolCalls: ["bash-1"],
          turns: [
            {
              id: "turn-1",
              message: "Test it",
              images: [],
              context: null,
              feedback: [],
              sentAt,
              ended: { at: sentAt, ending: TurnDone.make({}) },
              parts: [ThinkingPart.make({ text: "Run them." }), call("bash-1", "Bash", null)],
            },
          ],
        }),
      ),
  })

  const transcript = await screen.findByRole("region", { name: "Transcript" })
  expect(
    await within(transcript).findByRole("button", {
      name: "Worked · 1 tool call, 1 thought, 1 in the background",
    }),
  ).toBeTruthy()
  expect(
    within(transcript).getByText("Replied in 0s, still running in the background…"),
  ).toBeTruthy()
  expect(within(transcript).queryByText(/^Done in/)).toBeNull()
})

it("marks a tool call running in the background until its work ends, then continues its Turn with what ended", async () => {
  const ended = Deferred.makeUnsafe<void>()

  mount({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          queued: [],
          status: null,
          agentStatuses: ["Running a subagent: general-purpose: Count"],
          backgroundToolCalls: ["agent-1"],
          turns: [
            {
              id: "turn-1",
              message: "Start it",
              images: [],
              context: null,
              feedback: [],
              sentAt,
              ended: { at: sentAt, ending: TurnDone.make({}) },
              parts: [call("agent-1", "Agent", null)],
            },
          ],
        }),
      ).pipe(
        Stream.concat(
          Stream.fromEffect(
            Deferred.await(ended).pipe(Effect.as(AgentStatusesChanged.make({ agentStatuses: [] }))),
          ),
        ),
        Stream.concat(
          Stream.make(
            ToolCallStatusSet.make({ toolCallId: "agent-1", status: "failed" }),
            TurnStarted.make({
              turnId: "turn-2",
              message: "",
              images: [],
              feedback: [],
              sentAt,
              context: BackgroundWorkEnded.make({
                work: [
                  { kind: "subagent", description: "general-purpose: Count", outcome: "failed" },
                ],
              }),
            }),
            PartSet.make({
              turnId: "turn-2",
              index: 0,
              part: TextPart.make({ text: "It failed." }),
            }),
            TurnEnded.make({ turnId: "turn-2", ended: { at: sentAt, ending: TurnDone.make({}) } }),
          ),
        ),
      ),
  })

  const transcript = await screen.findByRole("region", { name: "Transcript" })
  expect(
    await within(transcript).findByRole("button", {
      name: "Running in the background: Agent agent-1",
    }),
  ).toBeTruthy()

  Deferred.doneUnsafe(ended, Exit.void)

  expect(await within(transcript).findByText("It failed.")).toBeTruthy()
  expect(within(transcript).getByRole("button", { name: "Failed: Agent agent-1" })).toBeTruthy()
  expect(within(transcript).getByText("Subagent general-purpose: Count failed")).toBeTruthy()
  expect(within(transcript).getAllByText(/^Done in/)).toHaveLength(1)
})

it("keeps the Turns Claude Code starts on its own with the Turn before them, under one ending", async () => {
  const later = DateTime.add(sentAt, { seconds: 65 })
  const done = { at: later, ending: TurnDone.make({}) }

  const unprompted = (id: string, text: string, context: Turn["context"]) => ({
    id,
    message: "",
    images: [],
    context,
    feedback: [],
    sentAt: later,
    ended: done,
    parts: [TextPart.make({ text })],
  })

  mount({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          queued: [],
          status: null,
          turns: [
            {
              id: "turn-1",
              message: "Start them",
              images: [],
              context: null,
              feedback: [],
              sentAt,
              ended: { at: sentAt, ending: TurnDone.make({}) },
              parts: [TextPart.make({ text: "Started." })],
            },
            unprompted(
              "turn-2",
              "The first is back.",
              BackgroundWorkEnded.make({
                work: [
                  { kind: "subagent", description: "Explore: Check it", outcome: "completed" },
                ],
              }),
            ),
            unprompted("turn-3", "The second is back.", null),
          ],
        }),
      ),
  })

  const transcript = await screen.findByRole("region", { name: "Transcript" })
  expect(await within(transcript).findByText("The second is back.")).toBeTruthy()
  expect(
    within(transcript)
      .getAllByText(/^Done in/)
      .map((line) => line.textContent),
  ).toEqual(["Done in 1m 5s"])
})

it("folds subagents started together into one line counting how they stand", async () => {
  const user = mount({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          queued: [],
          status: null,
          backgroundToolCalls: ["agent-1"],
          turns: [
            {
              id: "turn-1",
              message: "Review it",
              images: [],
              context: null,
              feedback: [],
              sentAt,
              ended: { at: sentAt, ending: TurnDone.make({}) },
              parts: [
                call("agent-1", "Agent", null),
                ToolCallPart.make({ ...call("agent-2", "Agent", null), status: "failed" }),
                call("agent-3", "Agent", null),
              ],
            },
          ],
        }),
      ),
  })

  const transcript = await screen.findByRole("region", { name: "Transcript" })

  const subagents = await within(transcript).findByRole("button", {
    name: "3 subagents · 1 running · 1 done · 1 failed",
  })

  await user.click(subagents)
  expect(
    await within(transcript).findByRole("button", {
      name: "Running in the background: Agent agent-1",
    }),
  ).toBeTruthy()
  expect(within(transcript).getByRole("button", { name: "Failed: Agent agent-2" })).toBeTruthy()
  expect(within(transcript).getByRole("button", { name: "Done: Agent agent-3" })).toBeTruthy()
})

it.each(["{Control>}n{/Control}", "{Meta>}n{/Meta}"])(
  "opens a New Thread with %s",
  async (shortcut) => {
    const user = mount({
      WatchTranscript: () =>
        Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    })

    await screen.findByRole("link", { name: thread.name })
    await user.keyboard(shortcut)

    await waitFor(() => expect(window.location.hash).toBe("#/threads/new"))
  },
)

it("shows a Turn cut off when Glass lost the Thread", async () => {
  const turnId = "turn-1"

  mount({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({ turns: [], queued: [], status: null }),
        TurnStarted.make({
          turnId,
          message: "Run echo",
          images: [],
          context: null,
          feedback: [],
          sentAt,
        }),
        TurnEnded.make({
          turnId,
          ended: { at: DateTime.add(sentAt, { seconds: 4 }), ending: TurnCutOff.make({}) },
        }),
      ),
  })

  const transcript = await screen.findByRole("region", { name: "Transcript" })
  expect(
    await within(transcript).findByText("Cut off after 4s when Glass lost the Thread"),
  ).toBeTruthy()
})

it("makes the open Thread the Saved place, which Activity leaves for Dashboard to continue", async () => {
  const saved: Array<ResumableDestination> = []

  const user = mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    SavePlace: ({ destination }) => {
      saved.push(destination)

      return Effect.succeed(new SavedPlace({ destination, savedAt: sentAt }))
    },
    ListActivity: () => Effect.succeed(new ActivityPage({ activities: [], hasMore: false })),
  })

  await waitFor(() => expect(saved).toEqual([{ area: "threads", threadId: thread.id }]))

  await user.click(screen.getByRole("link", { name: "Activity" }))
  await screen.findByText("No Activity yet")
  await user.click(screen.getByRole("link", { name: "Dashboard" }))
  await user.click(await screen.findByRole("link", { name: `Continue ${thread.name}` }))

  await waitFor(() => expect(window.location.hash).toBe(`#/threads/${thread.id}`))
  expect(saved).toHaveLength(1)
})

const waitingTurn = (parts: ReadonlyArray<TurnPart>) =>
  Stream.make(
    TranscriptSnapshot.make({
      turns: [
        {
          id: "turn-1",
          message: "List files",
          images: [],
          context: null,
          feedback: [],
          sentAt,
          ended: null,
          parts,
        },
      ],
      queued: [],
      status: null,
    }),
  )

const bashRequest = PermissionRequestPart.make({
  requestId: "bash-1",
  toolName: "Bash",
  inputSummary: "rm -rf build",
  input: '{ "command": "rm -rf build" }',
  status: "waiting",
  reason: null,
})

it("marks a Thread waiting on a Permission request, and denies it with a reason from its card", async () => {
  const answers: Array<{ requestId: string; answer: RequestAnswer }> = []

  const user = mount({
    WatchInbox: () =>
      Stream.make([
        InboxThread.make({
          thread,
          reasons: [WaitingRequests.make({ requests: [bashRequest] })],
          since: sentAt,
        }),
      ]),
    WatchTranscript: () => waitingTurn([bashRequest]),
    AnswerRequest: ({ requestId, answer }) =>
      Effect.sync(() => void answers.push({ requestId, answer })),
  })

  expect(
    await screen.findByRole("link", { name: thread.name, description: /Waiting on you/ }),
  ).toBeTruthy()

  const composer = await screen.findByRole("textbox", { name: "Message" })
  expect(composer.getAttribute("aria-placeholder")).toBe(
    "Answer the Permission request above first",
  )
  expect(screen.getByRole("button", { name: "Show it" })).toBeTruthy()

  const card = await screen.findByRole("region", { name: "Allow Bash?" })
  expect(within(card).getByText('{ "command": "rm -rf build" }')).toBeTruthy()
  await user.type(
    within(card).getByRole("textbox", { name: "Why not? (optional)" }),
    "Use git clean",
  )
  await user.click(within(card).getByRole("button", { name: "Deny" }))

  expect(answers).toEqual([
    { requestId: "bash-1", answer: DenyRequest.make({ reason: "Use git clean" }) },
  ])
})

it("allows a Permission request from its card and shows it as Allowed", async () => {
  const allowed = Deferred.makeUnsafe<RequestAnswer>()

  const user = mount({
    WatchTranscript: () =>
      waitingTurn([bashRequest]).pipe(
        Stream.concat(
          Stream.fromEffect(Deferred.await(allowed)).pipe(
            Stream.flatMap(() => waitingTurn([{ ...bashRequest, status: "allowed" }])),
          ),
        ),
      ),
    AnswerRequest: ({ answer }) => Deferred.succeed(allowed, answer).pipe(Effect.asVoid),
  })

  const card = await screen.findByRole("region", { name: "Allow Bash?" })
  await user.click(within(card).getByRole("button", { name: "Allow" }))

  expect(await within(card).findByText("Allowed")).toBeTruthy()
  expect(await Effect.runPromise(Deferred.await(allowed))).toEqual(AllowRequest.make({}))
})

const options = (...labels: ReadonlyArray<string>) =>
  labels.map((label) => ({ label, description: null }))

it("answers a Question with an option for one and the user's own words for another", async () => {
  const answers: Array<RequestAnswer> = []

  const user = mount({
    WatchTranscript: () =>
      waitingTurn([
        QuestionPart.make({
          requestId: "ask-1",
          questions: [
            {
              header: "Indent",
              question: "Tabs or spaces?",
              detail: null,
              options: options("Tabs", "Spaces"),
              multiSelect: false,
              freeText: true,
            },
            {
              header: null,
              question: "Which folders?",
              detail: null,
              options: options("src", "test"),
              multiSelect: true,
              freeText: true,
            },
          ],
          status: "waiting",
          answers: null,
        }),
      ]),
    AnswerRequest: ({ answer }) => Effect.sync(() => void answers.push(answer)),
  })

  const card = await screen.findByRole("region", { name: "The Thread asks you a few things" })
  const answer = within(card).getByRole("button", { name: "Answer" })
  expect(answer).toHaveProperty("disabled", true)

  await user.click(within(card).getByRole("radio", { name: "Spaces" }))
  const folders = within(card).getByRole("group", { name: "Which folders?" })
  await user.type(
    within(folders).getByRole("textbox", { name: "Or answer in your own words" }),
    "Only the README",
  )
  await user.click(answer)

  expect(answers).toEqual([
    AnswerQuestion.make({
      answers: [
        { chosen: ["Spaces"], text: null },
        { chosen: [], text: "Only the README" },
      ],
    }),
  ])
})

it("shows a request left when its Turn ended as no longer answerable", async () => {
  mount({
    WatchTranscript: () => waitingTurn([{ ...bashRequest, status: "expired" }]),
  })

  const card = await screen.findByRole("region", { name: "Allow Bash?" })
  expect(within(card).getByText("No longer answerable: its Turn ended.")).toBeTruthy()
  expect(within(card).queryByRole("button", { name: "Allow" })).toBeNull()
})

it("changes a Claude Code Thread's Permission mode from the composer, and offers none for pi", async () => {
  const changes: Array<string> = []

  const claudeThread = new Thread({
    ...threadFields,
    harness: "claude-code",
    permissionMode: "default",
  })

  const user = mount({
    WatchThreads: () => Stream.make([claudeThread]),
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    ChangePermissionMode: ({ permissionMode }) =>
      Effect.sync(() => changes.push(permissionMode)).pipe(
        Effect.as(new Thread({ ...threadFields, harness: "claude-code", permissionMode })),
      ),
  })

  await user.click(await screen.findByRole("combobox", { name: "Permission mode" }))
  await user.click(await screen.findByRole("option", { name: "Auto" }))
  expect(changes).toEqual(["auto"])

  cleanup()
  mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
  })
  await screen.findByRole("button", { name: "pi: gpt-test" })
  expect(screen.queryByRole("combobox", { name: "Permission mode" })).toBeNull()
})

const runningTurn = {
  id: "turn-1",
  message: "Build it",
  images: [],
  context: null,
  feedback: [],
  sentAt,
  ended: null,
  parts: [],
}

const running = (queued: ReadonlyArray<{ id: string; message: string }> = []) =>
  Stream.make(
    TranscriptSnapshot.make({
      turns: [runningTurn],
      queued: queued.map((message) => ({ ...message, images: [], context: null, feedback: [] })),
      status: null,
    }),
  )

it("queues a message sent with Enter while a Turn runs, and Steers one sent with ⌘Enter", async () => {
  const sent: Array<{ message: string; steer: boolean }> = []

  const user = mount({
    WatchTranscript: () => running(),
    SendMessage: ({ message }) => Effect.sync(() => void sent.push({ message, steer: false })),
    Steer: ({ message }) => Effect.sync(() => void sent.push({ message, steer: true })),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await waitFor(() => expect(composer.getAttribute("aria-placeholder")).toContain("⌘Enter"))
  await user.type(composer, "Then add docs{Enter}")
  await user.type(composer, "Use tabs{Meta>}{Enter}{/Meta}")

  expect(sent).toEqual([
    { message: "Then add docs", steer: false },
    { message: "Use tabs", steer: true },
  ])
})

it("lists Queued messages, cancels one, and sends one now once no Turn runs", async () => {
  const cancelled: Array<string> = []
  const sentNow: Array<string> = []
  const queued = [{ id: "queued-1", message: "Then add docs" }]

  const handlers = {
    CancelQueuedMessage: ({ queuedMessageId }: { queuedMessageId: string }) =>
      Effect.sync(() => {
        cancelled.push(queuedMessageId)

        return new UnsentFeedback({ notes: [], staged: [] })
      }),
    SendQueuedMessage: ({ queuedMessageId }: { queuedMessageId: string }) =>
      Effect.sync(() => void sentNow.push(queuedMessageId)),
  }

  const user = mount({ WatchTranscript: () => running(queued), ...handlers })

  const list = await screen.findByRole("region", { name: "Queued messages" })
  expect(within(list).queryByRole("button", { name: "Send now: Then add docs" })).toBeNull()
  await user.click(within(list).getByRole("button", { name: "Cancel: Then add docs" }))
  expect(cancelled).toEqual(["queued-1"])

  cleanup()

  const stopped = { ...runningTurn, ended: { at: sentAt, ending: TurnStopped.make({}) } }

  const again = mount({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          turns: [stopped],
          queued: queued.map((message) => ({
            ...message,
            images: [],
            context: null,
            feedback: [],
          })),
          status: null,
        }),
      ),
    ...handlers,
  })

  await again.click(await screen.findByRole("button", { name: "Send now: Then add docs" }))
  expect(sentNow).toEqual(["queued-1"])
})

it("says it's too late to cancel a Queued message that already started its Turn", async () => {
  const user = mount({
    WatchTranscript: () => running([{ id: "queued-1", message: "Then add docs" }]),
    CancelQueuedMessage: () => Effect.fail(new QueuedMessageStarted()),
  })

  const list = await screen.findByRole("region", { name: "Queued messages" })
  await user.click(within(list).getByRole("button", { name: "Cancel: Then add docs" }))

  expect(await screen.findByText("Too late to cancel")).toBeTruthy()
})

it("stops the running Turn, which then shows it was stopped", async () => {
  const stops: Array<string> = []
  const ended = Deferred.makeUnsafe<void>()

  const user = mount({
    WatchTranscript: () =>
      Stream.concat(
        running(),
        Stream.fromEffect(Deferred.await(ended)).pipe(
          Stream.as(
            TurnEnded.make({
              turnId: runningTurn.id,
              ended: { at: DateTime.add(sentAt, { seconds: 4 }), ending: TurnStopped.make({}) },
            }),
          ),
        ),
      ),
    StopTurn: ({ threadId }) =>
      Effect.sync(() => {
        stops.push(threadId)
        Deferred.doneUnsafe(ended, Exit.void)
      }),
  })

  await user.click(await screen.findByRole("button", { name: "Stop" }))

  expect(stops).toEqual([thread.id])
  expect(await screen.findByText("Stopped after 4s")).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull()
})

it("recalls the last message with ↑ in an empty composer", async () => {
  const user = mount({ WatchTranscript: () => running([{ id: "queued-1", message: "Then docs" }]) })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await screen.findByRole("region", { name: "Queued messages" })
  await user.click(composer)
  await user.keyboard("{ArrowUp}")

  expect(composer).toHaveProperty("textContent", "Then docs")
})

it("opens a pasted image large and sends it with the message", async () => {
  const sent: Array<{ message: string; images: ReadonlyArray<unknown> }> = []

  const user = mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    SendMessage: ({ message, images }) => Effect.sync(() => void sent.push({ message, images })),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  const bytes = Uint8Array.from(atob(pixel.data), (char) => char.charCodeAt(0))
  await user.click(composer)
  const clipboard = new DataTransfer()
  clipboard.items.add(new File([bytes], "pixel.png", { type: "image/png" }))
  await user.paste(clipboard)
  await user.click(await screen.findByRole("button", { name: "Open attachment 1" }))
  expect(await screen.findByRole("dialog", { name: "Attachment 1" })).toBeTruthy()
  await user.keyboard("{Escape}")
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

  await user.type(composer, "What's this?{Enter}")

  expect(sent).toEqual([{ message: "What's this?", images: [pixel] }])
})

it("shows the Thread's unsent message from before and saves what the user writes", async () => {
  const saved: Array<string> = []

  const user = mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    GetUnsentMessage: () => Effect.succeed({ message: "Half a", images: [] }),
    SaveUnsentMessage: ({ message }) => Effect.sync(() => void saved.push(message)),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await waitFor(() => expect(composer).toHaveProperty("textContent", "Half a"))
  await user.type(composer, " thought")

  await waitFor(() => expect(saved.at(-1)).toBe("Half a thought"))
})

it("saves what the user was still writing when they switch to another Thread", async () => {
  const other = new Thread({ ...threadFields, id: "agent-2", name: "agent/calm-heron" })
  const saved: Array<{ threadId: string; message: string }> = []

  const user = mount({
    WatchThreads: () => Stream.make([thread, other]),
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    SaveUnsentMessage: ({ threadId, message }) =>
      Effect.sync(() => void saved.push({ threadId, message })),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await user.type(composer.firstElementChild!, "Half a thought")
  await user.click(screen.getByRole("link", { name: other.name }))

  await waitFor(() =>
    expect(saved.at(-1)).toEqual({ threadId: thread.id, message: "Half a thought" }),
  )
})

const noTranscript = () =>
  Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null }))

const inSandboxWith = (reach: SandboxReach) =>
  new Thread({
    ...threadFields,
    place: SandboxPlace.make({ providerId: "fake" }),
    harness: "claude-code",
    permissionMode: "bypassPermissions",
    sandbox: new SandboxStatus({ expiresAt: DateTime.makeUnsafe("2026-10-28T12:00:00Z"), reach }),
  })

it("dims a Sandbox Thread Glass can't reach, and makes one whose Sandbox expired read-only", async () => {
  const reached: Array<string> = []

  const user = mount({
    WatchThreads: () => Stream.make([inSandboxWith("unreachable")]),
    WatchTranscript: noTranscript,
    ReachSandbox: ({ threadId }) =>
      Effect.sync(() => {
        reached.push(threadId)
      }),
  })

  const link = await screen.findByRole("link", { description: /Can't reach its Sandbox · Expires/ })
  expect(link.className).toContain("opacity-60")
  expect(
    screen.getByText(
      /Glass can't reach this Thread's Sandbox. Once it answers, Glass fills in what its agent did./,
    ),
  ).toBeTruthy()
  expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy()

  await user.click(screen.getByRole("button", { name: "Try again" }))
  await waitFor(() => expect(reached).toEqual([threadFields.id]))

  cleanup()
  mount({
    WatchThreads: () => Stream.make([inSandboxWith("expired")]),
    WatchTranscript: noTranscript,
  })

  expect(
    await screen.findByText(
      "This Thread's Sandbox expired, so it can't take messages. Its transcript stays until you remove the Thread.",
    ),
  ).toBeTruthy()
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull()
  expect(screen.getByRole("link", { description: /Sandbox expired/ })).toBeTruthy()
})

const flaky = new ToDo({ id: 3, title: "Fix the flaky test", notes: "", done: false })

it("mentions an open To-do picked after @, and shows the Mention as its title", async () => {
  const sent: Array<string> = []

  const user = mount({
    WatchToDos: () =>
      Stream.make([
        flaky,
        new ToDo({ id: 4, title: "Fix the docs", notes: "", done: true }),
        new ToDo({ id: 5, title: "Write the release notes", notes: "", done: false }),
      ]),
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({ turns: [], queued: [], status: null }),
        TurnStarted.make({
          turnId: "turn-1",
          message: `Earlier: ${toDoMention(flaky)}`,
          images: [],
          context: null,
          feedback: [],
          sentAt,
        }),
      ),
    SendMessage: ({ message }) => Effect.sync(() => void sent.push(message)),
  })

  const transcript = await screen.findByRole("region", { name: "Transcript" })
  expect(await within(transcript).findByText("Fix the flaky test")).toBeTruthy()
  expect(within(transcript).queryByText(/glass:\/\//)).toBeNull()

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await user.type(composer, "Look at @fix")
  const choices = await screen.findByRole("listbox", { name: "Mentions" })
  expect(
    within(choices)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Fix the flaky test"])

  await user.keyboard("{Enter}")
  expect(screen.queryByRole("listbox", { name: "Mentions" })).toBeNull()
  await user.type(composer, "now{Enter}")

  expect(sent).toEqual([`Look at ${toDoMention(flaky)} now`])
})

it("offers the Thread's files after its To-dos, those named after what's typed first", async () => {
  const sent: Array<string> = []

  const user = mount({
    WatchToDos: () => Stream.make([flaky]),
    ListThreadFiles: () => Effect.succeed(["fixtures/readme.md", "src/fix.ts", "docs/notes.md"]),
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    SendMessage: ({ message }) => Effect.sync(() => void sent.push(message)),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await user.type(composer, "Open @fix")
  const choices = await screen.findByRole("listbox", { name: "Mentions" })
  expect(
    within(choices)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Fix the flaky test", "fix.tssrc", "readme.mdfixtures"])

  await user.keyboard("{ArrowDown}{Enter}")
  await user.type(composer, "{Enter}")

  expect(sent).toEqual([`Open ${fileMention("src/fix.ts")}`])
})

it("keeps the To-do choices closed after Escape, so Enter sends the @ as written", async () => {
  const sent: Array<string> = []

  const user = mount({
    WatchToDos: () => Stream.make([flaky]),
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    SendMessage: ({ message }) => Effect.sync(() => void sent.push(message)),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await user.type(composer, "Ping @f")
  await screen.findByRole("listbox", { name: "Mentions" })
  await user.keyboard("{Escape}")
  expect(screen.queryByRole("listbox", { name: "Mentions" })).toBeNull()
  await user.keyboard("{Enter}")

  expect(sent).toEqual(["Ping @f"])
})

it("offers the harness's commands after a leading /, and only there", async () => {
  const sent: Array<string> = []

  const user = mount({
    ListThreadCommands: () =>
      Effect.succeed([
        { name: "greet", description: "Greets the user by name." },
        { name: "review", description: "Reviews the diff." },
      ]),
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    SendMessage: ({ message }) => Effect.sync(() => void sent.push(message)),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await user.type(composer, "/gr")
  const choices = await screen.findByRole("listbox", { name: "Commands" })
  expect(
    within(choices)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["/greetGreets the user by name."])

  await user.keyboard("{Enter}")
  expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull()
  await user.type(composer, "Ada{Enter}")
  expect(sent).toEqual(["/greet Ada"])

  await user.type(composer, "Run /gr")
  expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull()
})

it("keeps pasted lines and To-do mentions as written", async () => {
  const sent: Array<string> = []

  const pasted = `First\n\nThen ${toDoMention(flaky)} after`

  const user = mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    SendMessage: ({ message }) => Effect.sync(() => void sent.push(message)),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await user.click(composer)
  await user.paste(pasted)
  expect(within(composer).getByText("Fix the flaky test")).toBeTruthy()
  await user.keyboard("{Enter}")

  expect(sent).toEqual([pasted])
})

it("links the files a Turn named once it ends, and opens HTML in the Browser pane from the Thread's folder", async () => {
  const ended = Deferred.makeUnsafe<void>()
  const asked: Array<ReadonlyArray<string>> = []

  const user = mount({
    FindThreadFiles: ({ paths }) =>
      Effect.sync(() => {
        asked.push(paths)

        return paths.filter((path) => path.endsWith(".html"))
      }),
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          turns: [
            {
              ...runningTurn,
              parts: [TextPart.make({ text: "Built `docs/explainer.html` from `notes.md`." })],
            },
          ],
          queued: [],
          status: null,
        }),
      ).pipe(
        Stream.concat(
          Stream.fromEffect(
            Deferred.await(ended).pipe(
              Effect.as(
                TurnEnded.make({
                  turnId: runningTurn.id,
                  ended: { at: DateTime.add(sentAt, { seconds: 3 }), ending: TurnDone.make({}) },
                }),
              ),
            ),
          ),
        ),
      ),
  })

  const transcript = await screen.findByRole("region", { name: "Transcript" })
  await within(transcript).findByText("docs/explainer.html")
  expect(within(transcript).queryByRole("button", { name: /docs\/explainer\.html/ })).toBeNull()

  Deferred.doneUnsafe(ended, Exit.void)

  await user.click(await within(transcript).findByRole("button", { name: "docs/explainer.html" }))
  expect(within(transcript).queryByRole("button", { name: "notes.md" })).toBeNull()
  expect(asked).toContainEqual(["docs/explainer.html", "notes.md"])

  await screen.findByRole("complementary", { name: "Browser" })
  const { page, loaded } = attachPage()

  expect(page.getAttribute("partition")).toBe(BROWSER_PARTITION)
  await waitFor(() => expect(loaded).toEqual([threadFileAddress(thread.id, "docs/explainer.html")]))
})

it("shows a Turn's Markdown images and links to Windows paths in the Thread's folder, rereading images when a Turn ends", async () => {
  const read: Array<string> = []
  const nextEnded = Deferred.makeUnsafe<void>()
  const nextTurn = { ...runningTurn, id: "turn-2" }

  const user = mount({
    FindThreadFiles: ({ paths }) => Effect.succeed(paths),
    GetThreadFile: ({ path }) =>
      Effect.sync(() => {
        read.push(path)

        return path.endsWith(".png")
          ? ImageFile.make({ mediaType: "image/png", data: `shot${read.length}` })
          : TextFile.make({ text: "ran 3 tests" })
      }),
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          turns: [
            {
              ...runningTurn,
              parts: [
                TextPart.make({
                  text: "![The picker](C:\\work\\.verify\\picker.png)\n\nSee [the log](C:\\work\\.verify\\run.log:12).",
                }),
              ],
              ended: { at: sentAt, ending: TurnDone.make({}) },
            },
            nextTurn,
          ],
          queued: [],
          status: null,
        }),
      ).pipe(
        Stream.concat(
          Stream.fromEffect(
            Deferred.await(nextEnded).pipe(
              Effect.as(
                TurnEnded.make({
                  turnId: nextTurn.id,
                  ended: { at: DateTime.add(sentAt, { seconds: 3 }), ending: TurnDone.make({}) },
                }),
              ),
            ),
          ),
        ),
      ),
  })

  const transcript = await screen.findByRole("region", { name: "Transcript" })
  const image = await within(transcript).findByRole("img", { name: "The picker" })

  expect(image.getAttribute("src")).toBe("data:image/png;base64,shot1")
  expect(within(transcript).queryByText(/\[blocked\]/)).toBeNull()

  Deferred.doneUnsafe(nextEnded, Exit.void)

  await waitFor(() => expect(image.getAttribute("src")).toBe("data:image/png;base64,shot2"))

  await user.click(within(transcript).getByRole("button", { name: "The picker" }))

  const viewer = await screen.findByRole("dialog", { name: "The picker" })
  expect(within(viewer).getByRole("img").getAttribute("src")).toBe("data:image/png;base64,shot2")
  expect(screen.queryByRole("complementary", { name: "File" })).toBeNull()

  await user.keyboard("{Escape}")
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

  await user.click(await within(transcript).findByRole("button", { name: "the log" }))

  const pane = await screen.findByRole("complementary", { name: "File" })
  expect(within(pane).getByRole("heading", { name: "run.log" })).toBeTruthy()
  expect(read).toEqual([
    "C:\\work\\.verify\\picker.png",
    "C:\\work\\.verify\\picker.png",
    "C:\\work\\.verify\\run.log",
  ])
})

it("reloads an HTML file in the Browser pane when the next Turn ends, as the agent may have changed it", async () => {
  const nextEnded = Deferred.makeUnsafe<void>()
  const nextTurn = { ...runningTurn, id: "turn-2" }

  const user = mount({
    FindThreadFiles: ({ paths }) => Effect.succeed(paths),
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          turns: [
            {
              ...runningTurn,
              parts: [TextPart.make({ text: "Wrote `docs/plan.html`." })],
              ended: { at: sentAt, ending: TurnDone.make({}) },
            },
            nextTurn,
          ],
          queued: [],
          status: null,
        }),
      ).pipe(
        Stream.concat(
          Stream.fromEffect(
            Deferred.await(nextEnded).pipe(
              Effect.as(
                TurnEnded.make({
                  turnId: nextTurn.id,
                  ended: { at: DateTime.add(sentAt, { seconds: 3 }), ending: TurnDone.make({}) },
                }),
              ),
            ),
          ),
        ),
      ),
  })

  await user.click(await screen.findByRole("button", { name: "docs/plan.html" }))

  const { navigate, reloads } = attachPage()

  navigate(threadFileAddress(thread.id, "docs/plan.html"))
  expect(reloads()).toBe(0)

  Deferred.doneUnsafe(nextEnded, Exit.void)

  await waitFor(() => expect(reloads()).toBe(1))
})

it("drops an unsaved Feedback note's editor when the page loads again, as its part is gone", async () => {
  const user = mount({
    FindThreadFiles: ({ paths }) => Effect.succeed(paths),
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          turns: [
            {
              ...runningTurn,
              parts: [TextPart.make({ text: "Wrote `docs/plan.html`." })],
              ended: { at: sentAt, ending: TurnDone.make({}) },
            },
          ],
          queued: [],
          status: null,
        }),
      ),
  })

  await user.click(await screen.findByRole("button", { name: "docs/plan.html" }))

  await screen.findByRole("complementary", { name: "Browser" })
  const { navigate, fromPage, toPage } = attachPage()
  navigate(threadFileAddress(thread.id, "docs/plan.html"))
  fromPage({ type: "ready" })
  await waitFor(() => expect(toPage).not.toHaveLength(0))
  fromPage({
    type: "part",
    part: PageText.make({ selector: "body > p", heading: null, excerpt: "five per minute" }),
    rect: { top: 10, left: 10, bottom: 30, right: 200 },
  })

  const editor = await screen.findByRole("textbox", {
    name: "Feedback on the selected part of the page",
  })

  await user.type(editor, "Make this ten")

  fromPage({ type: "ready" })

  await waitFor(() =>
    expect(
      screen.queryByRole("textbox", { name: "Feedback on the selected part of the page" }),
    ).toBeNull(),
  )
})

const pageRequest = (id: string, restoreLastPage: boolean) =>
  new BrowserPageRequest({ id, threadId: thread.id, restoreLastPage })

it("opens the Thread's Browser pane for its agent, answers once its last page loads unless the agent names another, and lets go when the Turn ends", async () => {
  const answers = new Map<string, BrowserPageAnswer>()
  const loaded: Array<string> = []
  const lastPageLoaded = Promise.withResolvers<void>()
  localStorage.setItem(`glass.browserPane.${thread.id}`, "http://localhost:3000/settings")
  const turnEnded = Deferred.makeUnsafe<void>()

  vi.stubGlobal("glass", {
    browserRelay: (webContentsId: number) => Promise.resolve(`ws://relay/${webContentsId}`),
    onBrowserUserInput: () => undefined,
  })

  mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    WatchWorkingThreads: () =>
      Stream.make([thread.id]).pipe(
        Stream.concat(Stream.fromEffect(Deferred.await(turnEnded).pipe(Effect.as([])))),
      ),
    WatchBrowserPageRequests: () =>
      Stream.make([
        pageRequest("open", true),
        pageRequest("read", true),
        pageRequest("open-address", false),
      ]).pipe(Stream.concat(Stream.never)),
    AnswerBrowserPageRequest: ({ id, answer }) => Effect.sync(() => void answers.set(id, answer)),
  })

  await screen.findByRole("complementary", { name: "Browser" })

  const page = document.querySelector("webview")!
  Object.assign(page, {
    getWebContentsId: () => 7,
    getURL: () => "about:blank",
    loadURL: (url: string) => {
      loaded.push(url)

      return lastPageLoaded.promise
    },
  })
  page.dispatchEvent(new Event("dom-ready"))

  const ready = BrowserPageReady.make({ endpoint: "ws://relay/7" })

  await waitFor(() => expect([...answers]).toEqual([["open-address", ready]]))
  expect(loaded).toEqual(["http://localhost:3000/settings"])

  lastPageLoaded.resolve()

  await waitFor(() => expect(answers.size).toBe(3))
  expect([answers.get("open"), answers.get("read")]).toEqual([ready, ready])

  await userEvent.click(screen.getByRole("button", { name: "Close the Browser" }))
  expect(document.querySelector("webview")).toBe(page)

  Deferred.doneUnsafe(turnEnded, Exit.void)

  await waitFor(() => expect(document.querySelector("webview")).toBeNull())
})

const control = (agentUsing: boolean, userTookOver: boolean) => [
  new BrowserControl({ threadId: thread.id, agentUsing, userTookOver }),
]

it("shows the agent using the browser, takes it over when the user clicks or types in the agent's page, stopping the agent's page load, and hands it back", async () => {
  const answers = new Map<string, BrowserPageAnswer>()
  const controls = Effect.runSync(SubscriptionRef.make<ReadonlyArray<BrowserControl>>([]))
  const tookOver: Array<string> = []
  const handedBack: Array<string> = []
  const userInput = Promise.withResolvers<(webContentsId: number) => void>()

  vi.stubGlobal("glass", {
    browserRelay: (webContentsId: number) => Promise.resolve(`ws://relay/${webContentsId}`),
    onBrowserUserInput: (listener: (webContentsId: number) => void) => userInput.resolve(listener),
  })

  mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    WatchWorkingThreads: () => Stream.make([thread.id]).pipe(Stream.concat(Stream.never)),
    WatchBrowserPageRequests: () =>
      Stream.make([pageRequest("open", false)]).pipe(Stream.concat(Stream.never)),
    AnswerBrowserPageRequest: ({ id, answer }) => Effect.sync(() => void answers.set(id, answer)),
    WatchBrowserControl: () => SubscriptionRef.changes(controls),
    TakeOverBrowser: ({ threadId }) =>
      Effect.sync(() => void tookOver.push(threadId)).pipe(
        Effect.andThen(SubscriptionRef.set(controls, control(false, true))),
      ),
    HandBackBrowser: ({ threadId }) =>
      Effect.sync(() => void handedBack.push(threadId)).pipe(
        Effect.andThen(SubscriptionRef.set(controls, [])),
      ),
  })

  await screen.findByRole("complementary", { name: "Browser" })

  const { page } = attachPage()
  let stops = 0

  await waitFor(() => expect(answers.has("open")).toBe(true))

  await Effect.runPromise(SubscriptionRef.set(controls, control(true, false)))
  await screen.findByRole("status", { name: "Agent is using the browser" })
  expect(screen.queryByRole("button", { name: "Hand back to agent" })).toBeNull()

  const onUserInput = await userInput.promise
  onUserInput(8)
  Object.assign(page, { isWaitingForResponse: () => true, stop: () => void stops++ })
  onUserInput(7)

  const handBack = await screen.findByRole("button", { name: "Hand back to agent" })
  onUserInput(7)
  await userEvent.click(handBack)
  expect(tookOver).toEqual([thread.id])
  expect(stops).toBe(1)
  expect(screen.queryByText("Agent is using the browser")).toBeNull()

  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Hand back to agent" })).toBeNull(),
  )
  expect(handedBack).toEqual([thread.id])
})

const appLinkTurn = (place: Thread["place"]) => ({
  WatchThreads: () => Stream.make([new Thread({ ...threadFields, place })]),
  WatchTranscript: () =>
    Stream.make(
      TranscriptSnapshot.make({
        turns: [
          {
            ...runningTurn,
            parts: [
              TextPart.make({ text: "It runs at [the app](http://localhost:3000/settings)." }),
            ],
            ended: { at: sentAt, ending: TurnDone.make({}) },
          },
        ],
        queued: [],
        status: null,
      }),
    ),
})

it("opens a Turn's link to this device in a local Thread's Browser pane", async () => {
  const user = mount(appLinkTurn(thread.place))

  await user.click(await screen.findByRole("link", { name: "the app" }))

  const { loaded } = attachPage()

  await waitFor(() => expect(loaded).toEqual(["http://localhost:3000/settings"]))
})

it("closes a Thread's Browser pane when the user leaves the Thread", async () => {
  const other = new Thread({ ...threadFields, id: "agent-2", name: "agent/calm-heron" })

  const user = mount({
    ...appLinkTurn(thread.place),
    WatchThreads: () => Stream.make([thread, other]),
  })

  await user.click(await screen.findByRole("link", { name: "the app" }))
  const { loaded } = attachPage()
  await waitFor(() => expect(loaded).toEqual(["http://localhost:3000/settings"]))

  await user.click(screen.getByRole("link", { name: other.name }))
  await screen.findByRole("heading", { name: other.name })
  await user.click(screen.getByRole("link", { name: thread.name }))
  await screen.findByRole("heading", { name: thread.name })

  expect(screen.queryByRole("complementary", { name: "Browser" })).toBeNull()
})

it("shows a Sandbox Thread's Browser pane nothing from this device, not even an address it remembers", async () => {
  localStorage.setItem(`glass.browserPane.${thread.id}`, "http://localhost:3000/settings")
  const user = mount(appLinkTurn(SandboxPlace.make({ providerId: "fake" })))

  await user.click(await screen.findByRole("button", { name: "Details" }))
  await user.click(await screen.findByRole("button", { name: "Browser" }))

  const pane = await screen.findByRole("complementary", { name: "Browser" })
  expect(within(pane).getByText(/This Thread's apps run in its Sandbox/)).toBeTruthy()
})

it("leaves a Feedback note on the part of a page in the Browser pane the page reports, and sends it with the next message", async () => {
  let unsent = new UnsentFeedback({ notes: [], staged: [] })
  const sent: Array<{ message: string; feedback: ReadonlyArray<string> }> = []

  const user = mount({
    FindThreadFiles: ({ paths }) => Effect.succeed(paths),
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          turns: [
            {
              ...runningTurn,
              parts: [TextPart.make({ text: "Wrote `docs/plan.html`." })],
              ended: { at: sentAt, ending: TurnDone.make({}) },
            },
          ],
          queued: [],
          status: null,
        }),
      ),
    ListFeedbackNotes: () => Effect.sync(() => unsent),
    SaveFeedbackNote: ({ note }) =>
      Effect.sync(
        () =>
          (unsent = new UnsentFeedback({
            notes: [...unsent.notes, note],
            staged: [...unsent.staged, note.id],
          })),
      ),
    SendMessage: ({ message, feedback }) =>
      Effect.sync(() => void sent.push({ message, feedback })),
  })

  await user.click(await screen.findByRole("button", { name: "docs/plan.html" }))

  await screen.findByRole("complementary", { name: "Browser" })
  const { toPage, navigate, fromPage } = attachPage()
  navigate(threadFileAddress(thread.id, "docs/plan.html"))

  const part = PageText.make({
    selector: "body > p",
    heading: null,
    excerpt: "refill of five per minute",
  })

  fromPage({ type: "ready" })
  await waitFor(() => expect(toPage.at(-1)).toEqual({ pick: false, notes: [], active: null }))

  fromPage({ type: "part", part, rect: { top: 10, left: 10, bottom: 30, right: 200 } })

  await user.type(
    await screen.findByRole("textbox", { name: "Feedback on the selected part of the page" }),
    "Make this ten",
  )
  await user.keyboard("{Control>}{Enter}{/Control}")

  const attached = await screen.findByRole("region", { name: "Feedback attached to this message" })
  expect(within(attached).getByText("docs/plan.html · “refill of five per minute”")).toBeTruthy()
  expect(within(attached).getByText("Make this ten")).toBeTruthy()

  const [note] = unsent.notes
  expect(toPage.at(-1)).toEqual({ pick: false, notes: [{ id: note?.id, part }], active: null })

  fromPage({ type: "open", id: note!.id, rect: { top: 10, left: 10, bottom: 30, right: 200 } })
  await screen.findByRole("form", { name: "Edit Feedback note" })
  expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true)

  await user.click(screen.getByRole("button", { name: "Cancel" }))
  await user.type(screen.getByRole("textbox", { name: "Message" }), "{Enter}")

  await waitFor(() => expect(sent).toEqual([{ message: "", feedback: [note?.id] }]))
  await waitFor(() => expect(toPage.at(-1)).toEqual({ pick: false, notes: [], active: null }))
})
