// @vitest-environment happy-dom
import { RegistryProvider } from "@effect/atom-react"
import { GitHubConnection, ToDo, ToDoError } from "@glass/contracts"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Effect } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { App } from "./App"
import { backendLayerAtom } from "./backend"
import { type Held, hold, next, testLayer } from "../../test/testBackend"

const mount = (handlers: Parameters<typeof testLayer>[0]) => {
  const backend = testLayer({
    GetConnection: () =>
      Effect.succeed(new GitHubConnection({ login: "kevin", tokenSource: "gh" })),
    ...handlers,
  })

  window.history.replaceState(null, "", "#/to-dos")

  render(
    <RegistryProvider initialValues={[[backendLayerAtom, backend]]}>
      <App />
    </RegistryProvider>,
  )

  return userEvent.setup()
}

const fakeToDos = () => {
  let toDos: ReadonlyArray<ToDo> = []
  let nextId = 1

  const sorted = () =>
    Effect.succeed([...toDos.filter((toDo) => !toDo.done), ...toDos.filter((toDo) => toDo.done)])

  const update = (id: number, change: Partial<Omit<ToDo, "id">>) => {
    toDos = toDos.map((toDo) =>
      toDo.id === id
        ? new ToDo({
            id,
            title: change.title ?? toDo.title,
            notes: change.notes ?? toDo.notes,
            done: change.done ?? toDo.done,
          })
        : toDo,
    )

    return sorted()
  }

  return {
    ListToDos: sorted,
    AddToDo: ({ title }) => {
      toDos = [...toDos, new ToDo({ id: nextId++, title, notes: "", done: false })]

      return sorted()
    },
    EditToDo: ({ id, title, notes }) => update(id, { title, notes }),
    SetToDoDone: ({ id, done }) => update(id, { done }),
    DeleteToDo: ({ id }) => {
      toDos = toDos.filter((toDo) => toDo.id !== id)

      return sorted()
    },
  } satisfies Parameters<typeof testLayer>[0]
}

afterEach(() => {
  cleanup()
  window.history.replaceState(null, "", "#/")
})

it("confirms completion and reopening only after saving succeeds", async () => {
  const toDo = new ToDo({ id: 1, title: "Write release notes", notes: "", done: false })
  const changes: Array<Held<{ id: number; done: boolean }, ReadonlyArray<ToDo>, ToDoError>> = []
  const user = mount({ ListToDos: () => Effect.succeed([toDo]), SetToDoDone: hold(changes) })

  await user.click(await screen.findByRole("checkbox", { name: toDo.title }))
  const failed = await next(changes)
  expect(failed.payload).toEqual({ id: toDo.id, done: true })
  const completing = screen.getByRole("list", { name: "Open to-dos" })
  expect(
    within(completing).getByRole("checkbox", { name: toDo.title }).getAttribute("aria-checked"),
  ).toBe("true")
  expect(within(completing).getByText(toDo.title).classList.contains("line-through")).toBe(true)
  expect(screen.queryByText("To-do completed")).toBeNull()
  failed.answer(Effect.fail(new ToDoError({ message: "Couldn't save your to-do. Try again." })))
  await screen.findByRole("alert")
  expect(screen.queryByText("To-do completed")).toBeNull()
  expect(screen.getByRole("checkbox", { name: toDo.title }).getAttribute("aria-checked")).toBe(
    "false",
  )

  await user.click(screen.getByRole("checkbox", { name: toDo.title }))
  const complete = await next(changes)
  complete.answer(
    Effect.succeed([new ToDo({ id: toDo.id, title: toDo.title, notes: toDo.notes, done: true })]),
  )
  await screen.findByText("To-do completed")
  await user.click(screen.getByText("Done (1)"))
  const done = screen.getByRole("list", { name: "Done to-dos" })
  expect(
    within(done).getByRole("checkbox", { name: toDo.title }).getAttribute("aria-checked"),
  ).toBe("true")

  await user.click(within(done).getByRole("checkbox", { name: toDo.title }))
  const reopen = await next(changes)
  expect(reopen.payload).toEqual({ id: toDo.id, done: false })
  expect(screen.queryByText("To-do reopened")).toBeNull()
  reopen.answer(Effect.succeed([toDo]))
  await screen.findByText("To-do reopened")
  const open = screen.getByRole("list", { name: "Open to-dos" })
  expect(within(open).getByText(toDo.title)).toBeTruthy()
})

it("adds, edits, completes, reopens, and deletes to-dos", async () => {
  const user = mount(fakeToDos())
  const page = await screen.findByRole("main", { name: "To-dos" })
  await within(page).findByText("Nothing to do.")

  const input = within(page).getByRole<HTMLInputElement>("textbox", { name: "New to-do" })
  await user.type(input, "  Follow up on #42  {Enter}")
  const open = await within(page).findByRole("list", { name: "Open to-dos" })
  expect(within(open).getByText("Follow up on #42")).toBeTruthy()
  expect(input.value).toBe("")

  await user.click(within(open).getByRole("button", { name: "Edit Follow up on #42" }))
  const editor = within(page).getByRole("form", { name: "Edit Follow up on #42" })
  expect(document.activeElement).toBe(within(editor).getByRole("textbox", { name: "Title" }))
  await user.type(within(editor).getByRole("textbox", { name: "Notes" }), "After CI passes")
  await user.click(within(editor).getByRole("button", { name: "Save" }))
  expect(await within(open).findByText("After CI passes")).toBeTruthy()

  await user.click(within(open).getByRole("checkbox", { name: "Follow up on #42" }))
  const completing = within(page).getByRole("list", { name: "Open to-dos" })
  expect(
    within(completing)
      .getByRole("checkbox", { name: "Follow up on #42" })
      .getAttribute("aria-checked"),
  ).toBe("true")
  expect(within(completing).getByText("Follow up on #42").classList.contains("line-through")).toBe(
    true,
  )
  const done = await within(page).findByRole("list", { name: "Done to-dos" })
  expect(within(page).getByText("Done (1)")).toBeTruthy()
  expect(within(page).getByText("Nothing to do.")).toBeTruthy()

  await user.click(within(page).getByText("Done (1)"))
  await user.click(within(done).getByRole("checkbox", { name: "Follow up on #42" }))
  await within(page).findByRole("list", { name: "Open to-dos" })
  expect(within(page).queryByText("Done (1)")).toBeNull()

  await user.click(within(page).getByRole("button", { name: "Delete Follow up on #42" }))
  await within(page).findByText("Nothing to do.")
})

it("keeps the typed to-do and shows the problem when saving fails", async () => {
  const adds: Array<Held<{ title: string }, ReadonlyArray<ToDo>, ToDoError>> = []
  const user = mount({ ListToDos: () => Effect.succeed([]), AddToDo: hold(adds) })
  const page = await screen.findByRole("main", { name: "To-dos" })

  const input = await within(page).findByRole<HTMLInputElement>("textbox", { name: "New to-do" })
  await user.type(input, "Rebase the branch{Enter}")
  const add = await next(adds)
  expect(add.payload.title).toBe("Rebase the branch")
  expect(within(page).getByRole<HTMLButtonElement>("button", { name: "Add" }).disabled).toBe(true)

  add.answer(Effect.fail(new ToDoError({ message: "Couldn't save your to-do. Try again." })))
  expect((await within(page).findByRole("alert")).textContent).toContain("Couldn't save your to-do")
  expect(input.value).toBe("Rebase the branch")
  expect(within(page).getByText("Nothing to do.")).toBeTruthy()
})

it("keeps text typed while an add is saving", async () => {
  const adds: Array<Held<{ title: string }, ReadonlyArray<ToDo>, ToDoError>> = []
  const user = mount({ ListToDos: () => Effect.succeed([]), AddToDo: hold(adds) })
  const page = await screen.findByRole("main", { name: "To-dos" })

  const input = await within(page).findByRole<HTMLInputElement>("textbox", { name: "New to-do" })
  await user.type(input, "Rebase the branch{Enter}")
  const add = await next(adds)
  await user.type(input, " onto main")

  add.answer(
    Effect.succeed([new ToDo({ id: 1, title: "Rebase the branch", notes: "", done: false })]),
  )
  await within(page).findByRole("list", { name: "Open to-dos" })
  expect(input.value).toBe("Rebase the branch onto main")
})

it("keeps an unfinished edit across areas and text typed while it saves", async () => {
  const toDo = new ToDo({ id: 1, title: "Rebase the branch", notes: "", done: false })

  const edits: Array<
    Held<{ id: number; title: string; notes: string }, ReadonlyArray<ToDo>, ToDoError>
  > = []

  const user = mount({ ListToDos: () => Effect.succeed([toDo]), EditToDo: hold(edits) })

  await user.click(await screen.findByRole("button", { name: "Edit Rebase the branch" }))
  await user.type(screen.getByRole("textbox", { name: "Notes" }), "Onto main")
  await user.click(screen.getByRole("link", { name: "Settings" }))
  await screen.findByRole("main", { name: "Settings" })
  await user.click(screen.getByRole("link", { name: "To-dos" }))
  const notes = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Notes" })
  expect(notes.value).toBe("Onto main")

  await user.click(screen.getByRole("button", { name: "Save" }))
  const edit = await next(edits)
  expect(edit.payload.notes).toBe("Onto main")
  await user.type(notes, ", then squash")
  edit.answer(Effect.succeed([new ToDo({ ...edit.payload, done: false })]))

  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(false),
  )
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Notes" }).value).toBe(
    "Onto main, then squash",
  )
})
