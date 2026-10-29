// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react"
import { Draft, LinePlace } from "@glass/contracts"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Effect } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { LineDraft } from "./Drafts"
import { DraftStore } from "./useDrafts"
import { type Handlers, type Held, hold, next, testRegistry } from "../../test/testBackend"
import { workspace } from "../../test/workspace"

const lineDraft = (id: string, line: number, body = "Hi") =>
  new Draft({ id, path: "greet.ts", place: LinePlace.make({ side: "new", line }), body })

const registries: Array<ReturnType<typeof testRegistry>> = []

afterEach(() => {
  cleanup()

  for (const registry of registries.splice(0)) registry.dispose()
})

it("keeps a nonempty Draft on Cancel or Escape and deletes only after confirmation", async () => {
  const deleted: Array<string> = []

  const registry = testRegistry({
    DeleteDraft: ({ id }) => {
      deleted.push(id)

      return Effect.void
    },
  })

  registries.push(registry)

  const store = new DraftStore(
    workspace([lineDraft("D1", 2, "Keep this feedback")]),
    registry,
    () => {},
  )

  render(
    <RegistryContext.Provider value={registry}>
      <LineDraft store={store} draftKey="D1" onReload={() => {}} onAsk={() => {}} />
    </RegistryContext.Provider>,
  )
  const user = userEvent.setup()

  const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Draft on greet.ts line +2",
  })

  await user.click(editor)
  await user.keyboard("{Escape}")
  const dialog = await screen.findByRole("alertdialog", { name: "Delete this Draft?" })
  const cancel = within(dialog).getByRole("button", { name: "Cancel" })
  await waitFor(() => expect(document.activeElement).toBe(cancel))
  expect(deleted).toEqual([])
  await user.click(cancel)
  await waitFor(() => expect(document.activeElement).toBe(editor))
  expect(editor.value).toBe("Keep this feedback")

  await user.keyboard("{Escape}")
  await screen.findByRole("alertdialog")
  await user.keyboard("{Escape}")
  await waitFor(() => expect(document.activeElement).toBe(editor))
  expect(deleted).toEqual([])

  await user.keyboard("{Escape}")
  await user.click(await screen.findByRole("button", { name: "Delete Draft" }))
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull())
  expect(deleted).toEqual(["D1"])
})

it("dismisses an empty new Draft on Escape without asking", async () => {
  const registry = testRegistry({})
  registries.push(registry)
  const store = new DraftStore(workspace(), registry, () => {})
  store.start("greet.ts", "new", 2)
  const key = store.views()[0]!.key
  render(
    <RegistryContext.Provider value={registry}>
      <LineDraft store={store} draftKey={key} onReload={() => {}} onAsk={() => {}} />
    </RegistryContext.Provider>,
  )
  const user = userEvent.setup()
  await user.keyboard("{Escape}")
  expect(screen.queryByRole("textbox")).toBeNull()
  expect(screen.queryByRole("alertdialog")).toBeNull()
  expect(store.views()).toEqual([])
})

it("offers a new Draft to the agent, but keeps a saved Draft a Draft", async () => {
  const registry = testRegistry({})
  registries.push(registry)
  const store = new DraftStore(workspace([lineDraft("D1", 3)]), registry, () => {})
  let asks = 0
  store.start("greet.ts", "new", 2)
  const key = store.views().find((draft) => draft.key !== "D1")!.key
  render(
    <RegistryContext.Provider value={registry}>
      <LineDraft store={store} draftKey="D1" onReload={() => {}} onAsk={() => {}} />
      <LineDraft
        store={store}
        draftKey={key}
        onReload={() => {}}
        onAsk={() => {
          asks += 1
        }}
      />
    </RegistryContext.Provider>,
  )
  const user = userEvent.setup()

  expect(screen.queryByRole("button", { name: /^Ask the agent/ })).toBeNull()
  await user.keyboard("Who calls this?")
  expect(screen.getByRole("button", { name: "Ask the agent about greet.ts line +2" })).toBeDefined()
  expect(screen.queryByRole("button", { name: "Ask the agent about greet.ts line +3" })).toBeNull()

  await user.keyboard("{Meta>}{Enter}{/Meta}")
  expect(asks).toBe(1)
})

it("stops offering Ask once the Draft's first save is on its way to GitHub", async () => {
  const creates: Array<Held<Parameters<Handlers["CreateDraft"]>[0], Draft, never>> = []
  const registry = testRegistry({ CreateDraft: hold(creates) })
  registries.push(registry)
  const store = new DraftStore(workspace(), registry, () => {})
  let asks = 0
  store.start("greet.ts", "new", 2)
  render(
    <RegistryContext.Provider value={registry}>
      <LineDraft
        store={store}
        draftKey={store.views()[0]!.key}
        onReload={() => {}}
        onAsk={() => {
          asks += 1
        }}
      />
    </RegistryContext.Provider>,
  )
  const user = userEvent.setup()

  await user.keyboard("Who calls this?{Enter}")
  const create = await next(creates)

  expect(screen.queryByRole("button", { name: /^Ask the agent/ })).toBeNull()
  await user.keyboard("{Meta>}{Enter}{/Meta}")
  expect(asks).toBe(0)

  create.answer(Effect.succeed(lineDraft("D1", 2, "Who calls this?")))
  expect(await screen.findByText("Saved privately")).toBeDefined()
})

it("offers Comment only while it's the only Draft, publishing it without the Review summary and showing its Discussion", async () => {
  const submitted: Array<{ decision: string; summary: string }> = []
  let reloads = 0

  const registry = testRegistry({
    DeleteDraft: () => Effect.void,
    SubmitReview: ({ decision, summary }) => {
      submitted.push({ decision, summary })

      return Effect.void
    },
  })

  registries.push(registry)

  const store = new DraftStore(
    workspace([lineDraft("D1", 2), lineDraft("D2", 3)]),
    registry,
    () => {},
    "Later",
  )

  render(
    <RegistryContext.Provider value={registry}>
      <LineDraft store={store} draftKey="D1" onReload={() => (reloads += 1)} onAsk={() => {}} />
    </RegistryContext.Provider>,
  )
  const comment = { name: "Comment with Draft on greet.ts line +2" }
  expect(screen.queryByRole("button", comment)).toBeNull()

  store.remove("D2")
  await userEvent.setup().click(await screen.findByRole("button", comment))
  await waitFor(() => expect(reloads).toBe(1))
  expect(submitted).toEqual([{ decision: "comment", summary: "" }])
  expect(store.summary()).toBe("Later")
  screen.getByText("Unresolved thread on")
  screen.getByText("octocat")
  screen.getByText("Published")
  expect(screen.queryByRole("textbox")).toBeNull()
})

it("saves on Enter, adds a line on Option+Enter, and comments on Shift+Enter", async () => {
  const updated: Array<string> = []
  const submitted: Array<string> = []
  let reloads = 0

  const registry = testRegistry({
    UpdateDraft: ({ body }) => {
      updated.push(body)

      return Effect.void
    },
    SubmitReview: ({ decision }) => {
      submitted.push(decision)

      return Effect.void
    },
  })

  registries.push(registry)
  const store = new DraftStore(workspace([lineDraft("D1", 2)]), registry, () => {})
  render(
    <RegistryContext.Provider value={registry}>
      <LineDraft store={store} draftKey="D1" onReload={() => (reloads += 1)} onAsk={() => {}} />
    </RegistryContext.Provider>,
  )
  const user = userEvent.setup()

  await user.type(screen.getByRole("textbox"), "!{Alt>}{Enter}{/Alt}more")
  screen.getByText("Not saved")
  expect(updated).toEqual([])

  await user.keyboard("{Enter}")
  await screen.findByText("Saved privately")
  expect(updated).toEqual(["Hi!\nmore"])

  await user.keyboard("{Shift>}{Enter}{/Shift}")
  await waitFor(() => expect(reloads).toBe(1))
  expect(submitted).toEqual(["comment"])
})
