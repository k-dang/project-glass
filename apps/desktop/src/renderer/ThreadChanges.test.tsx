// @vitest-environment happy-dom
import {
  ThreadChanges,
  ThreadError,
  AgentModels,
  type FeedbackNote,
  LineNote,
  GitHubConnection,
  TranscriptSnapshot,
  TurnDone,
  TurnEnded,
  UnsentFeedback,
} from "@glass/contracts"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event"
import { DateTime, Deferred, Effect, Exit, Stream } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { App } from "./App"
import { backendLayerAtom } from "./backend"
import { thread } from "../../test/thread"
import { testLayer } from "../../test/testBackend"
import { changedFile } from "../../test/workspace"
import { RegistryProvider } from "../../test/registry"

const sentAt = DateTime.makeUnsafe("2026-10-26T12:00:00Z")

const idle = () => Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null }))

const note = (id: string, changesId: string, text: string) =>
  new LineNote({
    id,
    path: "greet.ts",
    side: "new",
    start: 2,
    end: 2,
    code: "B",
    changesId,
    text,
  })

const unsent = (...notes: ReadonlyArray<FeedbackNote>) => new UnsentFeedback({ notes })

const savedNotes = (...initial: ReadonlyArray<FeedbackNote>) => {
  let current = unsent(...initial)

  const write = (kept: ReadonlyArray<FeedbackNote>) =>
    Effect.sync(() => (current = unsent(...kept)))

  return {
    current: () => current,
    handlers: {
      ListFeedbackNotes: () => Effect.sync(() => current),
      SaveFeedbackNote: ({ note: written }) =>
        write(
          current.notes.some(({ id }) => id === written.id)
            ? current.notes.map((kept) => (kept.id === written.id ? written : kept))
            : [...current.notes, written],
        ),
      RemoveFeedbackNote: ({ noteId }) => write(current.notes.filter(({ id }) => id !== noteId)),
    } satisfies Parameters<typeof testLayer>[0],
  }
}

const changes = (id: string) => new ThreadChanges({ id, files: [changedFile("greet.ts")] })

const openChanges = async (handlers: Parameters<typeof testLayer>[0]) => {
  const backend = testLayer({
    GetConnection: () =>
      Effect.succeed(new GitHubConnection({ login: "kevin", tokenSource: "gh" })),
    WatchThreads: () => Stream.make([thread]),
    ListAgentModels: () => Effect.succeed(new AgentModels({ defaultModel: null, models: [] })),
    ...handlers,
  })

  window.history.replaceState(null, "", `#/threads/${thread.id}`)

  render(
    <RegistryProvider initialValues={[[backendLayerAtom, backend]]}>
      <App />
    </RegistryProvider>,
  )

  const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
  await user.click(await screen.findByRole("textbox", { name: "Message" }))
  await user.keyboard("{Control>}d{/Control}")
  await screen.findByRole("complementary", { name: "Pane picker" })
  await user.keyboard("d")
  const region = await screen.findByRole("complementary", { name: "Changes" })

  return { user, region }
}

afterEach(() => {
  cleanup()
  window.history.replaceState(null, "", "#/")
})

const attachment = () => screen.findByRole("region", { name: "Feedback attached to this message" })

it("edits and removes Feedback notes, listing older ones only on the composer with their code", async () => {
  const store = savedNotes(note("current", "read-2", "Rename B"), note("older", "read-1", "Drop B"))

  const { user, region } = await openChanges({
    WatchTranscript: idle,
    GetThreadChanges: () => Effect.succeed(changes("read-2")),
    ...store.handlers,
  })

  const current = await within(region).findByRole("article", {
    name: "Feedback on greet.ts New line 2",
  })

  expect(within(region).queryByText("Drop B")).toBeNull()

  const attached = await attachment()
  const [, older] = within(attached).getAllByRole("article")
  expect(within(older!).getByText("Drop B")).toBeTruthy()
  expect(within(older!).getByText("B")).toBeTruthy()

  await user.click(within(current).getByRole("button", { name: "Edit" }))
  const editor = within(region).getByRole("textbox", { name: "Feedback on selected code" })
  await user.clear(editor)
  await user.type(editor, "Rename B to Greeting")
  await user.click(within(region).getByRole("button", { name: "Save changes" }))

  expect(await within(attached).findByText("Rename B to Greeting")).toBeTruthy()

  await user.click(within(older!).getByRole("button", { name: "Remove" }))
  await waitFor(() => expect(within(attached).queryByText("Drop B")).toBeNull())
  expect(store.current().notes).toEqual([note("current", "read-2", "Rename B to Greeting")])
})

it("keeps what the user wrote when a Feedback note can't be saved, until a retry saves it", async () => {
  let attempts = 0
  const { handlers } = savedNotes(note("current", "read-1", "Rename B"))

  const { user, region } = await openChanges({
    WatchTranscript: idle,
    GetThreadChanges: () => Effect.succeed(changes("read-1")),
    ...handlers,
    SaveFeedbackNote: (payload) =>
      ++attempts === 1
        ? Effect.fail(new ThreadError({ message: "Disk is full." }))
        : handlers.SaveFeedbackNote(payload),
  })

  await user.click(await within(region).findByRole("button", { name: "Edit" }))
  const editor = within(region).getByRole("textbox", { name: "Feedback on selected code" })
  await user.type(editor, " to Greeting")
  await user.keyboard("{Control>}{Enter}{/Control}")

  expect(await within(region).findByText("Disk is full.")).toBeTruthy()
  expect(editor).toHaveProperty("value", "Rename B to Greeting")

  await user.click(within(region).getByRole("button", { name: "Save changes" }))
  expect(await within(region).findByText("Rename B to Greeting")).toBeTruthy()
  expect(within(region).queryByText("Disk is full.")).toBeNull()
})

it("keeps the displayed Changes and their notes when Show latest fails, until a retry reads the latest", async () => {
  const turnEnded = Deferred.makeUnsafe<void>()

  const reads: Array<Effect.Effect<ThreadChanges, ThreadError>> = [
    Effect.succeed(changes("read-1")),
    Effect.fail(new ThreadError({ message: "The Sandbox didn't answer." })),
    Effect.succeed(changes("read-2")),
  ]

  const { user, region } = await openChanges({
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
    GetThreadChanges: () => reads.shift()!,
    ListFeedbackNotes: () => Effect.succeed(unsent(note("current", "read-1", "Rename B"))),
  })

  const listed = await within(region).findByRole("article", {
    name: "Feedback on greet.ts New line 2",
  })

  Deferred.doneUnsafe(turnEnded, Exit.void)
  await user.click(await within(region).findByRole("button", { name: "Show latest" }))

  expect(await within(region).findByText("The Sandbox didn't answer.")).toBeTruthy()
  expect(listed.isConnected).toBe(true)

  await user.click(within(region).getByRole("button", { name: "Retry" }))
  await waitFor(() => expect(within(region).queryByText("Rename B")).toBeNull())
})

it("shows the Changes while Feedback notes can't load, then the notes once a retry reads them", async () => {
  const lists: Array<Effect.Effect<UnsentFeedback, ThreadError>> = [
    Effect.fail(new ThreadError({ message: "Couldn't read your Feedback notes. Try again." })),
    Effect.succeed(unsent(note("current", "read-1", "Rename B"))),
  ]

  const { user, region } = await openChanges({
    WatchTranscript: idle,
    GetThreadChanges: () => Effect.succeed(changes("read-1")),
    ListFeedbackNotes: () => lists.shift()!,
  })

  expect(
    await within(region).findByText("Couldn't read your Feedback notes. Try again."),
  ).toBeTruthy()
  expect(await within(region).findByText("1 file changed")).toBeTruthy()
  expect(within(region).queryByText(/No feedback yet/)).toBeNull()

  await user.click(within(region).getByRole("button", { name: "Retry" }))
  expect(await within(region).findByText("Rename B")).toBeTruthy()
})

it("keeps the note being edited until it's saved or cancelled", async () => {
  const { user, region } = await openChanges({
    WatchTranscript: idle,
    GetThreadChanges: () => Effect.succeed(changes("read-1")),
    ListFeedbackNotes: () =>
      Effect.succeed(
        unsent(note("first", "read-1", "Rename B"), note("second", "read-1", "Test B")),
      ),
  })

  const [first, second] = await within(region).findAllByRole("article", {
    name: "Feedback on greet.ts New line 2",
  })

  await user.click(within(first!).getByRole("button", { name: "Edit" }))
  await user.type(within(region).getByRole("textbox", { name: "Feedback on selected code" }), "!")

  expect(within(region).queryByRole("button", { name: "Add feedback" })).toBeNull()
  expect(within(second!).getByRole("button", { name: "Edit" })).toHaveProperty("disabled", true)

  await user.click(within(region).getByRole("button", { name: "Cancel" }))
  const edits = await within(region).findAllByRole("button", { name: "Edit" })
  expect(edits.map((edit) => edit.hasAttribute("disabled"))).toEqual([false, false])
})

it("attaches saved Feedback notes beside the unsent text and sends them as one message once accepted", async () => {
  const store = savedNotes(note("first", "read-1", "Rename B"), note("second", "read-1", "Test B"))
  const sent: Array<{ message: string; feedback: ReadonlyArray<string> }> = []
  let attempts = 0

  const { user, region } = await openChanges({
    WatchTranscript: idle,
    GetThreadChanges: () => Effect.succeed(changes("read-1")),
    GetUnsentMessage: () => Effect.succeed({ message: "Also add docs", images: [] }),
    ...store.handlers,
    SendMessage: ({ message, feedback }) =>
      ++attempts === 1
        ? Effect.fail(new ThreadError({ message: "Couldn't read or save the transcript." }))
        : Effect.sync(() => void sent.push({ message, feedback })),
  })

  const attached = await attachment()
  expect(within(attached).getAllByRole("article")).toHaveLength(2)
  expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe("Also add docs")

  const [first] = within(attached).getAllByRole("article")
  await user.click(within(first!).getByRole("button", { name: "Edit" }))
  await user.type(within(attached).getByRole("textbox", { name: "Feedback on selected code" }), "!")
  expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true)
  await user.click(within(attached).getByRole("button", { name: "Save changes" }))
  expect(await within(attached).findByText("Rename B!")).toBeTruthy()
  expect(store.current().notes[0]).toEqual(note("first", "read-1", "Rename B!"))

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
  expect(within(region).queryByRole("article")).toBeNull()
})

it("shows sent and Queued Feedback notes with the code they were left on", async () => {
  const feedback = [note("first", "read-1", "Rename B")]

  await openChanges({
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
    GetThreadChanges: () => Effect.succeed(changes("read-1")),
  })

  const queue = await screen.findByRole("region", { name: "Queued messages" })
  expect(within(queue).getByText("Feedback notes without a message")).toBeTruthy()
  expect(within(queue).getByText("1 Feedback note")).toBeTruthy()

  const transcript = screen.getByRole("region", { name: "Transcript" })
  expect(within(transcript).getByText("1 Feedback note")).toBeTruthy()
  expect(within(transcript).getByText("Rename B", { exact: true })).toBeTruthy()
})

it("returns a canceled Queued message's Feedback notes beside newer work once a retry cancels it", async () => {
  const store = savedNotes(note("newer", "read-2", "Newer"))
  const queuedNote = note("queued", "read-1", "Cap the attempts")
  let attempts = 0

  const queued = [
    { id: "queued-1", message: "", images: [], context: null, feedback: [queuedNote] },
  ]

  const { user, region } = await openChanges({
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
              ended: null,
              parts: [],
            },
          ],
          queued,
          status: null,
        }),
      ),
    GetThreadChanges: () => Effect.succeed(changes("read-2")),
    GetUnsentMessage: () => Effect.succeed({ message: "Also add docs", images: [] }),
    ...store.handlers,
    CancelQueuedMessage: () =>
      ++attempts === 1
        ? Effect.fail(new ThreadError({ message: "Couldn't cancel a Queued message." }))
        : store.handlers.SaveFeedbackNote({ threadId: thread.id, note: queuedNote }),
  })

  const attached = await attachment()

  const queue = await screen.findByRole("region", { name: "Queued messages" })
  const cancelFeedback = "Cancel: Feedback notes without a message"
  await user.click(within(queue).getByRole("button", { name: cancelFeedback }))
  expect(await screen.findByText("Couldn't cancel a Queued message.")).toBeTruthy()

  await user.click(within(queue).getByRole("button", { name: cancelFeedback }))
  await waitFor(() => expect(store.current().notes).toHaveLength(2))

  const [, restored] = await within(attached).findAllByRole("article")
  expect(within(restored!).getByText("Cap the attempts")).toBeTruthy()
  expect(within(restored!).getByText("B")).toBeTruthy()
  expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe("Also add docs")
  expect(within(region).getByText("Newer")).toBeTruthy()
  expect(within(region).queryByText("Cap the attempts")).toBeNull()
})

it("selects lines with Shift+Arrow keys and starts a Feedback note on them with Enter", async () => {
  const { user, region } = await openChanges({
    WatchTranscript: idle,
    GetThreadChanges: () => Effect.succeed(changes("read-1")),
    ...savedNotes().handlers,
  })

  await user.click(await within(region).findByRole("button", { name: "Show greet.ts" }))
  const diff = within(region).getByRole("button", { name: "Hide greet.ts" }).parentElement!
  fireEvent.keyDown(diff, { key: "ArrowDown", shiftKey: true })
  fireEvent.keyDown(diff, { key: "Enter" })

  const editor = await within(region).findByRole("textbox", { name: "Feedback on selected code" })
  await user.type(editor, "Rename A")
  await user.click(within(region).getByRole("button", { name: "Add note" }))

  expect(await within(region).findByText("Rename A")).toBeTruthy()
})
