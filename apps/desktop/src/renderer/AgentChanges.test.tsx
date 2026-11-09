// @vitest-environment happy-dom
import { RegistryProvider } from "@effect/atom-react"
import {
  AgentChanges,
  AgentError,
  AgentModels,
  FeedbackNote,
  GitHubConnection,
  TranscriptSnapshot,
  TurnDone,
  TurnEnded,
  UnsentFeedback,
} from "@glass/contracts"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DateTime, Deferred, Effect, Exit, Stream } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { App } from "./App"
import { backendLayerAtom } from "./backend"
import { agent } from "../../test/agent"
import { testLayer } from "../../test/testBackend"
import { changedFile } from "../../test/workspace"

const sentAt = DateTime.makeUnsafe("2026-10-26T12:00:00Z")

const idle = () => Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null }))

const note = (id: string, changesId: string, text: string) =>
  new FeedbackNote({
    id,
    path: "greet.ts",
    side: "new",
    start: 2,
    end: 2,
    code: "B",
    changesId,
    text,
  })

const unsent = (...notes: ReadonlyArray<FeedbackNote>) => new UnsentFeedback({ notes, staged: [] })

const changes = (id: string) => new AgentChanges({ id, files: [changedFile("greet.ts")] })

const openChanges = async (handlers: Parameters<typeof testLayer>[0]) => {
  const backend = testLayer({
    GetConnection: () =>
      Effect.succeed(new GitHubConnection({ login: "kevin", tokenSource: "gh" })),
    WatchAgents: () => Stream.make([agent]),
    ListAgentModels: () => Effect.succeed(new AgentModels({ defaultModel: null, models: [] })),
    ...handlers,
  })

  window.history.replaceState(null, "", `#/agents/${agent.id}`)

  render(
    <RegistryProvider initialValues={[[backendLayerAtom, backend]]}>
      <App />
    </RegistryProvider>,
  )

  const user = userEvent.setup()
  await user.click(await screen.findByRole("textbox", { name: "Message" }))
  await user.keyboard("{Control>}d{/Control}")
  const region = await screen.findByRole("region", { name: "Changes" })
  await user.click(await within(region).findByRole("tab", { name: /Feedback/ }))
  const overview = await within(region).findByRole("tabpanel", { name: /Feedback/ })

  return { user, region, overview }
}

afterEach(() => {
  cleanup()
  window.history.replaceState(null, "", "#/")
})

it("edits and removes Feedback notes, keeping older ones with their original code", async () => {
  const saved: Array<FeedbackNote> = []
  const removed: Array<string> = []

  const { user, region, overview } = await openChanges({
    WatchTranscript: idle,
    GetAgentChanges: () => Effect.succeed(changes("read-2")),
    ListFeedbackNotes: () =>
      Effect.succeed(
        unsent(note("current", "read-2", "Rename B"), note("older", "read-1", "Drop B")),
      ),
    SaveFeedbackNote: (payload) => Effect.sync(() => void saved.push(payload.note)),
    RemoveFeedbackNote: ({ noteId }) => Effect.sync(() => void removed.push(noteId)),
  })

  const [current, older] = await within(overview).findAllByRole("article", {
    name: "Feedback on greet.ts New line 2",
  })

  expect(within(current!).queryByText("Older version")).toBeNull()
  expect(within(older!).getByText("Older version")).toBeTruthy()
  expect(within(older!).getByText("B")).toBeTruthy()

  await user.click(within(older!).getByRole("button", { name: "Edit" }))
  const editor = within(region).getByRole("textbox", { name: "Feedback on selected code" })
  expect(editor).toHaveProperty("value", "Drop B")
  await user.clear(editor)
  await user.type(editor, "Keep B after all")
  await user.click(within(region).getByRole("button", { name: "Save changes" }))

  expect(await within(overview).findByText("Keep B after all")).toBeTruthy()
  expect(saved).toEqual([note("older", "read-1", "Keep B after all")])

  await user.click(within(current!).getByRole("button", { name: "Remove" }))
  await waitFor(() => expect(within(region).queryByText("Rename B")).toBeNull())
  expect(removed).toEqual(["current"])
})

it("keeps what the user wrote when a Feedback note can't be saved, until a retry saves it", async () => {
  let attempts = 0

  const { user, region, overview } = await openChanges({
    WatchTranscript: idle,
    GetAgentChanges: () => Effect.succeed(changes("read-1")),
    ListFeedbackNotes: () => Effect.succeed(unsent(note("current", "read-1", "Rename B"))),
    SaveFeedbackNote: () =>
      ++attempts === 1 ? Effect.fail(new AgentError({ message: "Disk is full." })) : Effect.void,
  })

  await user.click(await within(overview).findByRole("button", { name: "Edit" }))
  const editor = within(region).getByRole("textbox", { name: "Feedback on selected code" })
  await user.type(editor, " to Greeting")
  await user.keyboard("{Control>}{Enter}{/Control}")

  expect(await within(region).findByText("Disk is full.")).toBeTruthy()
  expect(editor).toHaveProperty("value", "Rename B to Greeting")

  await user.click(within(region).getByRole("button", { name: "Save changes" }))
  expect(await within(overview).findByText("Rename B to Greeting")).toBeTruthy()
  expect(within(region).queryByText("Disk is full.")).toBeNull()
})

it("keeps the displayed Changes when Show latest fails, then marks notes older once it succeeds", async () => {
  const turnEnded = Deferred.makeUnsafe<void>()

  const reads: Array<Effect.Effect<AgentChanges, AgentError>> = [
    Effect.succeed(changes("read-1")),
    Effect.fail(new AgentError({ message: "The Sandbox didn't answer." })),
    Effect.succeed(changes("read-2")),
  ]

  const { user, region, overview } = await openChanges({
    WatchTranscript: () =>
      Stream.concat(
        Stream.make(
          TranscriptSnapshot.make({
            turns: [
              {
                id: "t",
                message: "Work",
                images: [],
                context: null,
                feedback: [],
                sentAt,
                ended: null,
                parts: [],
              },
            ],
            queued: [],
            status: null,
          }),
        ),
        Stream.fromEffect(Deferred.await(turnEnded)).pipe(
          Stream.as(
            TurnEnded.make({ turnId: "t", ended: { at: sentAt, ending: TurnDone.make({}) } }),
          ),
        ),
      ),
    GetAgentChanges: () => reads.shift()!,
    ListFeedbackNotes: () => Effect.succeed(unsent(note("current", "read-1", "Rename B"))),
  })

  const listed = await within(overview).findByRole("article", {
    name: "Feedback on greet.ts New line 2",
  })

  Deferred.doneUnsafe(turnEnded, Exit.void)
  await user.click(await within(region).findByRole("button", { name: "Show latest" }))

  expect(await within(region).findByText("The Sandbox didn't answer.")).toBeTruthy()
  expect(within(listed).queryByText("Older version")).toBeNull()

  await user.click(within(region).getByRole("button", { name: "Retry" }))
  expect(
    await within(
      await within(await within(region).findByRole("tabpanel", { name: /Feedback/ })).findByRole(
        "article",
        { name: "Feedback on greet.ts New line 2" },
      ),
    ).findByText("Older version"),
  ).toBeTruthy()
})

it("shows the Changes while Feedback notes can't load, then the notes once a retry reads them", async () => {
  const lists: Array<Effect.Effect<UnsentFeedback, AgentError>> = [
    Effect.fail(new AgentError({ message: "Couldn't read your Feedback notes. Try again." })),
    Effect.succeed(unsent(note("current", "read-1", "Rename B"))),
  ]

  const { user, region } = await openChanges({
    WatchTranscript: idle,
    GetAgentChanges: () => Effect.succeed(changes("read-1")),
    ListFeedbackNotes: () => lists.shift()!,
  })

  expect(
    await within(region).findByText("Couldn't read your Feedback notes. Try again."),
  ).toBeTruthy()
  expect(within(region).getByText("1 file changed")).toBeTruthy()
  expect(within(region).queryByText(/No feedback yet/)).toBeNull()

  await user.click(within(region).getByRole("button", { name: "Retry" }))
  const overview = within(region).getByRole("tabpanel", { name: /Feedback/ })
  expect(await within(overview).findByText("Rename B")).toBeTruthy()
})

it("keeps the note being edited from the Feedback tab until it's saved or cancelled", async () => {
  const { user, region, overview } = await openChanges({
    WatchTranscript: idle,
    GetAgentChanges: () => Effect.succeed(changes("read-1")),
    ListFeedbackNotes: () =>
      Effect.succeed(
        unsent(note("first", "read-1", "Rename B"), note("second", "read-1", "Test B")),
      ),
  })

  const [first, second] = await within(overview).findAllByRole("article", {
    name: "Feedback on greet.ts New line 2",
  })

  await user.click(within(first!).getByRole("button", { name: "Edit" }))
  await user.type(within(overview).getByRole("textbox", { name: "Feedback on selected code" }), "!")

  expect(within(region).queryByRole("button", { name: "Add feedback" })).toBeNull()
  expect(within(second!).getByRole("button", { name: "Edit" })).toHaveProperty("disabled", true)

  await user.click(within(overview).getByRole("button", { name: "Cancel" }))
  expect(within(second!).getByRole("button", { name: "Edit" })).toHaveProperty("disabled", false)
})

it("keeps Feedback notes readable when the Changes can't be read", async () => {
  const { region, overview } = await openChanges({
    WatchTranscript: idle,
    GetAgentChanges: () => Effect.fail(new AgentError({ message: "The Sandbox expired." })),
    ListFeedbackNotes: () => Effect.succeed(unsent(note("current", "read-1", "Rename B"))),
  })

  expect(within(region).getByText("The Sandbox expired.")).toBeTruthy()

  const kept = await within(overview).findByRole("article", {
    name: "Feedback on greet.ts New line 2",
  })

  expect(within(kept).getByText("Older version")).toBeTruthy()
  expect(within(kept).getByText("Rename B")).toBeTruthy()
})

it("keeps an unsaved edit while the Files tab is shown", async () => {
  const { user, region, overview } = await openChanges({
    WatchTranscript: idle,
    GetAgentChanges: () => Effect.succeed(changes("read-1")),
    ListFeedbackNotes: () => Effect.succeed(unsent(note("current", "read-1", "Rename B"))),
  })

  await user.click(await within(overview).findByRole("button", { name: "Edit" }))
  await user.type(within(overview).getByRole("textbox", { name: "Feedback on selected code" }), "!")
  await user.click(within(region).getByRole("tab", { name: "Files" }))
  await user.click(within(region).getByRole("tab", { name: /Feedback/ }))

  const reopened = within(region).getByRole("tabpanel", { name: /Feedback/ })
  expect(
    within(reopened).getByRole("textbox", { name: "Feedback on selected code" }),
  ).toHaveProperty("value", "Rename B!")
})

it("stages Feedback notes beside the unsent text and sends them as one message once accepted", async () => {
  const staged: Array<ReadonlyArray<string>> = []
  const saved: Array<FeedbackNote> = []
  const sent: Array<{ message: string; feedback: ReadonlyArray<string> }> = []
  let attempts = 0

  const { user, region } = await openChanges({
    WatchTranscript: idle,
    GetAgentChanges: () => Effect.succeed(changes("read-1")),
    GetUnsentMessage: () => Effect.succeed({ message: "Also add docs", images: [] }),
    ListFeedbackNotes: () =>
      Effect.sync(() => {
        const notes = [note("first", "read-1", "Rename B"), note("second", "read-1", "Test B")]

        return new UnsentFeedback({
          notes: notes.map((kept) => saved.findLast(({ id }) => id === kept.id) ?? kept),
          staged: staged.at(-1) ?? [],
        })
      }),
    StageFeedbackNotes: ({ noteIds }) => Effect.sync(() => void staged.push(noteIds)),
    SaveFeedbackNote: (payload) => Effect.sync(() => void saved.push(payload.note)),
    SendMessage: ({ message, feedback }) =>
      ++attempts === 1
        ? Effect.fail(new AgentError({ message: "Couldn't read or save the transcript." }))
        : Effect.sync(() => void sent.push({ message, feedback })),
  })

  await user.click(within(region).getByRole("button", { name: "Review feedback" }))
  const attached = await screen.findByRole("region", { name: "Feedback attached to this message" })
  expect(staged).toEqual([["first", "second"]])
  expect(within(attached).getAllByRole("article")).toHaveLength(2)
  expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe("Also add docs")

  const [first] = within(attached).getAllByRole("article")
  await user.click(within(first!).getByRole("button", { name: "Edit" }))
  await user.type(within(attached).getByRole("textbox", { name: "Feedback on selected code" }), "!")
  await user.click(within(attached).getByRole("button", { name: "Save changes" }))
  expect(await within(attached).findByText("Rename B!")).toBeTruthy()
  expect(saved).toEqual([note("first", "read-1", "Rename B!")])

  await user.click(screen.getByRole("button", { name: "Send" }))
  expect(await screen.findByText("Couldn't read or save the transcript.")).toBeTruthy()
  expect(within(attached).getAllByRole("article")).toHaveLength(2)
  expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe("Also add docs")

  await user.click(screen.getByRole("button", { name: "Send" }))
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Feedback attached to this message" })).toBeNull(),
  )
  expect(sent).toEqual([{ message: "Also add docs", feedback: ["first", "second"] }])
  expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe("")
  expect(within(region).queryByRole("button", { name: "Review feedback" })).toBeNull()
})

it("shows sent and Queued Feedback notes with the code they were left on", async () => {
  const feedback = [note("first", "read-1", "Rename B")]

  const { user } = await openChanges({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          turns: [
            {
              id: "turn-1",
              message: "",
              images: [],
              context: null,
              feedback,
              sentAt,
              ended: null,
              parts: [],
            },
          ],
          queued: [{ id: "queued-1", message: "", images: [], context: null, feedback }],
          status: null,
        }),
      ),
    GetAgentChanges: () => Effect.succeed(changes("read-1")),
  })

  await user.keyboard("{Control>}d{/Control}")
  const queue = await screen.findByRole("region", { name: "Queued messages" })
  expect(within(queue).getByText("Feedback on the Agent's changes")).toBeTruthy()
  expect(within(queue).getByText("1 Feedback note")).toBeTruthy()

  const transcript = screen.getByRole("region", { name: "Transcript" })
  expect(within(transcript).getByText("1 Feedback note")).toBeTruthy()
  expect(within(transcript).getByText("Rename B", { exact: true })).toBeTruthy()
})
