// @vitest-environment happy-dom
import { RegistryProvider } from "@effect/atom-react"
import {
  GitHubConnection,
  ToDo,
  ToDoError,
  ToDoImage,
  type ToDoImageUpload,
} from "@glass/contracts"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Effect } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { App } from "./App"
import { backendLayerAtom } from "./backend"
import { maxToDoImageBytes } from "./pastedImages"
import { type Handlers, type Held, hold, next, testLayer } from "../../test/testBackend"

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
            images: change.images ?? toDo.images,
          })
        : toDo,
    )

    return sorted()
  }

  let nextImageId = 1
  const stored = new Map<number, ToDoImageUpload>()

  const remember = (images: ReadonlyArray<ToDoImageUpload>) =>
    images.map((image) => {
      const id = nextImageId++
      stored.set(id, image)

      return new ToDoImage({ id, mediaType: image.mediaType })
    })

  return {
    ListToDos: sorted,
    AddToDo: ({ title, notes, images }) => {
      toDos = [
        ...toDos,
        new ToDo({
          id: nextId++,
          title,
          notes,
          done: false,
          images: remember(images ?? []),
        }),
      ]

      return sorted()
    },
    EditToDo: ({ id, title, notes }) => update(id, { title, notes }),
    SetToDoDone: ({ id, done }) => update(id, { done }),
    DeleteToDo: ({ id }) => {
      toDos = toDos.filter((toDo) => toDo.id !== id)

      return sorted()
    },
    AttachToDoImages: ({ id, images }) =>
      update(id, {
        images: [
          ...(toDos.find((toDo) => toDo.id === id)?.images ?? []),
          ...remember(images ?? []),
        ],
      }),
    RemoveToDoImage: ({ id }) => {
      stored.delete(id)
      toDos = toDos.map(
        (toDo) =>
          new ToDo({
            id: toDo.id,
            title: toDo.title,
            notes: toDo.notes,
            done: toDo.done,
            images: toDo.images.filter((image) => image.id !== id),
          }),
      )

      return sorted()
    },
    ReadToDoImage: ({ id, size }) => {
      const image = stored.get(id)

      return image === undefined
        ? Effect.fail(new ToDoError({ message: "Couldn't open that image. Try again." }))
        : Effect.succeed({
            mediaType: size === "thumbnail" ? image.thumbnailMediaType : image.mediaType,
            data: size === "thumbnail" ? image.thumbnail : image.data,
          })
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
  await user.type(
    within(editor).getByRole("textbox", { name: "Notes for Follow up on #42" }),
    "After CI passes",
  )
  await user.click(within(editor).getByRole("button", { name: "Save" }))
  expect(await within(open).findByText("After CI passes")).toBeTruthy()

  await user.click(within(open).getByRole("checkbox", { name: "Follow up on #42" }))
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
  const adds: Array<Held<{ title: string; notes: string }, ReadonlyArray<ToDo>, ToDoError>> = []
  const user = mount({ ListToDos: () => Effect.succeed([]), AddToDo: hold(adds) })
  const page = await screen.findByRole("main", { name: "To-dos" })

  const input = await within(page).findByRole<HTMLInputElement>("textbox", { name: "New to-do" })
  await user.type(input, "Rebase the branch{Enter}")
  const add = await next(adds)
  expect(add.payload).toEqual({ title: "Rebase the branch", notes: "", images: [] })
  expect(within(page).getByRole<HTMLButtonElement>("button", { name: "Add" }).disabled).toBe(true)

  add.answer(Effect.fail(new ToDoError({ message: "Couldn't save your to-do. Try again." })))
  expect((await within(page).findByRole("alert")).textContent).toContain("Couldn't save your to-do")
  expect(input.value).toBe("Rebase the branch")
  expect(within(page).getByText("Nothing to do.")).toBeTruthy()
})

it("keeps text typed while an add is saving", async () => {
  const adds: Array<Held<{ title: string; notes: string }, ReadonlyArray<ToDo>, ToDoError>> = []
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
  const formName = "Edit Rebase the branch"

  const notes = () =>
    within(screen.getByRole("form", { name: formName })).getByRole<HTMLTextAreaElement>("textbox", {
      name: "Notes for Rebase the branch",
    })

  await user.type(notes(), "Onto main")
  await user.click(screen.getByRole("link", { name: "Settings" }))
  await screen.findByRole("main", { name: "Settings" })
  await user.click(screen.getByRole("link", { name: "To-dos" }))
  expect(notes().value).toBe("Onto main")

  await user.click(screen.getByRole("button", { name: "Save" }))
  const edit = await next(edits)
  expect(edit.payload.notes).toBe("Onto main")
  await user.type(notes(), ", then squash")
  edit.answer(Effect.succeed([new ToDo({ ...edit.payload, done: false })]))

  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(false),
  )
  expect(notes().value).toBe("Onto main, then squash")
})

it("saves notes typed while adding a to-do", async () => {
  const user = mount(fakeToDos())
  const page = await screen.findByRole("main", { name: "To-dos" })
  const form = within(page).getByRole("form", { name: "Add a to-do" })
  const title = within(form).getByRole<HTMLInputElement>("textbox", { name: "New to-do" })
  const notes = within(form).getByRole<HTMLTextAreaElement>("textbox", { name: "Notes" })
  expect(notes.value).toBe("")
  expect(form.textContent).toContain("↵")
  expect(within(form).getByRole("button", { name: "Add" }).textContent).toBe("Add")

  await user.type(notes, "After CI passes   ")
  await user.type(title, "Follow up on #42{Enter}")
  const open = await within(page).findByRole("list", { name: "Open to-dos" })
  expect(within(open).getByText("Follow up on #42")).toBeTruthy()
  expect(within(open).getByText(/After CI passes/).textContent).toBe("After CI passes")
  expect(title.value).toBe("")
  expect(notes.value).toBe("")

  await user.type(title, "Rebase the branch")
  await user.type(notes, "Onto main{Enter}then squash")
  expect(within(open).queryByText("Rebase the branch")).toBeNull()
  await user.keyboard("{Control>}{Enter}{/Control}")
  expect(await within(open).findByText(/then squash/)).toBeTruthy()
  expect(within(open).getByText(/then squash/).textContent).toBe("Onto main\nthen squash")

  await user.type(title, "Ship the flag")
  await user.type(notes, "Mention the flag")
  await user.keyboard("{Meta>}{Enter}{/Meta}")
  expect(await within(open).findByText("Mention the flag")).toBeTruthy()
  expect(title.value).toBe("")
  expect(within(form).getByRole<HTMLTextAreaElement>("textbox", { name: "Notes" }).value).toBe("")
})

const pixel = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

const pasteImage = async (user: ReturnType<typeof userEvent.setup>, name = "pixel.png") => {
  const clipboard = new DataTransfer()
  clipboard.items.add(new File([pixel], name, { type: "image/png" }))
  await user.paste(clipboard)
}

it("adds a to-do with pasted images and can drop one before saving", async () => {
  const adds: Array<Held<Parameters<Handlers["AddToDo"]>[0], ReadonlyArray<ToDo>, ToDoError>> = []

  const attaches: Array<
    Held<Parameters<Handlers["AttachToDoImages"]>[0], ReadonlyArray<ToDo>, ToDoError>
  > = []

  const user = mount({
    ListToDos: () => Effect.succeed([]),
    AddToDo: hold(adds),
    AttachToDoImages: hold(attaches),
  })

  const form = within(await screen.findByRole("form", { name: "Add a to-do" }))
  const title = form.getByRole("textbox", { name: "New to-do" })

  await user.click(title)
  await pasteImage(user)
  await pasteImage(user, "second.png")
  expect(await form.findByRole("button", { name: "Open image 1" })).toBeTruthy()
  expect(form.getByRole("button", { name: "Open image 2" })).toBeTruthy()

  await user.click(form.getByRole("button", { name: "Remove image 2" }))
  expect(form.queryByRole("button", { name: "Open image 2" })).toBeNull()

  await user.type(title, "Screenshot the dialog")
  await user.click(form.getByRole("button", { name: "Add" }))
  const add = await next(adds)
  expect(add.payload.title).toBe("Screenshot the dialog")
  expect(add.payload.images ?? []).toEqual([])
  add.answer(
    Effect.succeed([
      new ToDo({ id: 1, title: "Screenshot the dialog", notes: "", done: false, images: [] }),
    ]),
  )

  const attach = await next(attaches)
  const images = attach.payload.images ?? []
  expect(attach.payload.id).toBe(1)
  expect(images).toHaveLength(1)
  expect(images[0]?.mediaType).toBe("image/png")
  expect(images[0]?.data.length).toBeGreaterThan(0)
  expect(images[0]?.thumbnail).not.toBe(images[0]?.data)
})

it("sends each pasted image in its own message", async () => {
  const adds: Array<Held<Parameters<Handlers["AddToDo"]>[0], ReadonlyArray<ToDo>, ToDoError>> = []

  const attaches: Array<
    Held<Parameters<Handlers["AttachToDoImages"]>[0], ReadonlyArray<ToDo>, ToDoError>
  > = []

  const user = mount({
    ListToDos: () => Effect.succeed([]),
    AddToDo: hold(adds),
    AttachToDoImages: hold(attaches),
  })

  const form = within(await screen.findByRole("form", { name: "Add a to-do" }))
  const title = form.getByRole("textbox", { name: "New to-do" })

  await user.click(title)
  await pasteImage(user, "one.png")
  await pasteImage(user, "two.png")
  await user.type(title, "Two shots")
  await user.click(form.getByRole("button", { name: "Add" }))

  const add = await next(adds)
  expect(add.payload.images ?? []).toEqual([])
  add.answer(
    Effect.succeed([new ToDo({ id: 4, title: "Two shots", notes: "", done: false, images: [] })]),
  )

  const first = await next(attaches)
  expect(first.payload.images).toHaveLength(1)
  first.answer(
    Effect.succeed([
      new ToDo({
        id: 4,
        title: "Two shots",
        notes: "",
        done: false,
        images: [new ToDoImage({ id: 1, mediaType: "image/png" })],
      }),
    ]),
  )

  const second = await next(attaches)
  expect(second.payload.id).toBe(4)
  expect(second.payload.images).toHaveLength(1)
  expect(attaches).toHaveLength(0)
})

it("keeps an image that failed to attach and retries it on the same to-do", async () => {
  const adds: Array<Held<Parameters<Handlers["AddToDo"]>[0], ReadonlyArray<ToDo>, ToDoError>> = []

  const attaches: Array<
    Held<Parameters<Handlers["AttachToDoImages"]>[0], ReadonlyArray<ToDo>, ToDoError>
  > = []

  const user = mount({
    ListToDos: () => Effect.succeed([]),
    AddToDo: hold(adds),
    AttachToDoImages: hold(attaches),
  })

  const form = within(await screen.findByRole("form", { name: "Add a to-do" }))
  const title = form.getByRole("textbox", { name: "New to-do" })

  await user.click(title)
  await pasteImage(user)
  await user.type(title, "Retry the shot")
  await user.click(form.getByRole("button", { name: "Add" }))

  const add = await next(adds)
  add.answer(
    Effect.succeed([
      new ToDo({ id: 4, title: "Retry the shot", notes: "", done: false, images: [] }),
    ]),
  )

  const failed = await next(attaches)
  expect(failed.payload.images).toHaveLength(1)
  failed.answer(Effect.fail(new ToDoError({ message: "Couldn't save your to-do. Try again." })))

  expect(await form.findByText("Couldn't save every image. Try again.")).toBeTruthy()
  expect(form.getByRole("button", { name: "Open image 1" })).toBeTruthy()
  await user.click(form.getByRole("button", { name: "Try again" }))

  const retry = await next(attaches)
  expect(retry.payload.id).toBe(4)
  expect(retry.payload.images).toHaveLength(1)
  expect(adds).toHaveLength(0)
})

it("tells you when a pasted image is too big to send and keeps the smaller ones", async () => {
  const user = mount({ ListToDos: () => Effect.succeed([]) })
  const form = within(await screen.findByRole("form", { name: "Add a to-do" }))
  const huge = new File([pixel], "huge.png", { type: "image/png" })
  Object.defineProperty(huge, "size", { value: maxToDoImageBytes + 1 })
  const clipboard = new DataTransfer()
  clipboard.items.add(huge)
  clipboard.items.add(new File([pixel], "ok.png", { type: "image/png" }))

  await user.click(form.getByRole("textbox", { name: "New to-do" }))
  await user.paste(clipboard)

  expect(await screen.findByText("huge.png is too big to attach")).toBeTruthy()
  expect(form.getByRole("button", { name: "Open image 1" })).toBeTruthy()
  expect(form.queryByRole("button", { name: "Open image 2" })).toBeNull()
})

it("keeps a paste made while another to-do change is saving", async () => {
  const toDo = new ToDo({ id: 1, title: "Write release notes", notes: "", done: false })
  const changes: Array<Held<{ id: number; done: boolean }, ReadonlyArray<ToDo>, ToDoError>> = []

  const attaches: Array<
    Held<Parameters<Handlers["AttachToDoImages"]>[0], ReadonlyArray<ToDo>, ToDoError>
  > = []

  const user = mount({
    ListToDos: () => Effect.succeed([toDo]),
    SetToDoDone: hold(changes),
    AttachToDoImages: hold(attaches),
  })

  const open = await screen.findByRole("list", { name: "Open to-dos" })

  await user.click(within(open).getByRole("checkbox", { name: toDo.title }))
  const saving = await next(changes)
  await user.click(within(open).getByText(toDo.title))
  await pasteImage(user)

  expect(
    await within(open).findByRole("list", { name: "Images to save on Write release notes" }),
  ).toBeTruthy()
  expect(attaches).toHaveLength(0)

  saving.answer(
    Effect.succeed([new ToDo({ id: toDo.id, title: toDo.title, notes: toDo.notes, done: true })]),
  )
  const attach = await next(attaches)
  expect(attach.payload.id).toBe(toDo.id)
  expect(attach.payload.images).toHaveLength(1)
})

it("sends images pasted onto a to-do one at a time and holds them after a failure", async () => {
  const toDo = new ToDo({ id: 1, title: "Write release notes", notes: "", done: false })

  const attaches: Array<
    Held<Parameters<Handlers["AttachToDoImages"]>[0], ReadonlyArray<ToDo>, ToDoError>
  > = []

  const user = mount({
    ListToDos: () => Effect.succeed([toDo]),
    AttachToDoImages: hold(attaches),
  })

  const open = await screen.findByRole("list", { name: "Open to-dos" })
  await user.click(within(open).getByText(toDo.title))
  await pasteImage(user, "one.png")
  await pasteImage(user, "two.png")

  const unsent = await within(open).findByRole("list", {
    name: "Images to save on Write release notes",
  })

  await waitFor(() => expect(within(unsent).getAllByRole("listitem")).toHaveLength(2))

  const failed = await next(attaches)
  expect(attaches).toHaveLength(0)
  failed.answer(Effect.fail(new ToDoError({ message: "Couldn't save your to-do. Try again." })))

  const tryAgain = await within(open).findByRole("button", { name: "Try again" })
  expect(attaches).toHaveLength(0)
  expect(within(unsent).getAllByRole("listitem")).toHaveLength(2)

  await user.click(tryAgain)
  const first = await next(attaches)
  first.answer(Effect.succeed([toDo]))

  const second = await next(attaches)
  expect(second.payload.id).toBe(toDo.id)
  second.answer(Effect.succeed([toDo]))

  await waitFor(() =>
    expect(
      within(open).queryByRole("list", { name: "Images to save on Write release notes" }),
    ).toBeNull(),
  )
  expect(attaches).toHaveLength(0)
})

it("puts the newest open to-do directly under the composer", async () => {
  const user = mount(fakeToDos())
  const page = await screen.findByRole("main", { name: "To-dos" })

  const form = () => within(page).getByRole("form", { name: "Add a to-do" })

  const openTitles = () =>
    within(page)
      .getAllByRole("checkbox")
      .map((box) => box.getAttribute("aria-label"))

  await user.type(within(form()).getByRole("textbox", { name: "New to-do" }), "Older errand{Enter}")
  await within(page).findByText("Older errand")

  await user.type(
    within(form()).getByRole("textbox", { name: "Notes" }),
    "See the plan before deciding",
  )
  await user.type(within(form()).getByRole("textbox", { name: "New to-do" }), "Newer errand{Enter}")
  await within(page).findByText("Newer errand")

  const open = within(page).getByRole("list", { name: "Open to-dos" })
  expect(form().compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(openTitles()).toEqual(["Newer errand", "Older errand"])
  expect(
    within(open).getByText("See the plan before deciding").classList.contains("line-clamp-2"),
  ).toBe(true)
})

it("keeps finished to-dos collapsed and in the order the server sent", async () => {
  const user = mount({
    ListToDos: () =>
      Effect.succeed([
        new ToDo({ id: 1, title: "Older errand", notes: "", done: false }),
        new ToDo({ id: 2, title: "Newer errand", notes: "", done: false }),
        new ToDo({ id: 4, title: "Finished just now", notes: "", done: true }),
        new ToDo({ id: 3, title: "Finished earlier", notes: "", done: true }),
      ]),
  })

  const page = await screen.findByRole("main", { name: "To-dos" })
  const done = within(page).getByText("Done (2)").closest("details")
  expect(done instanceof HTMLDetailsElement && done.open).toBe(false)
  expect(
    within(page)
      .getAllByRole("checkbox")
      .map((box) => box.getAttribute("aria-label")),
  ).toEqual(["Newer errand", "Older errand", "Finished just now", "Finished earlier"])

  await user.click(within(page).getByText("Done (2)"))
  expect(done instanceof HTMLDetailsElement && done.open).toBe(true)
})

it("pastes an image onto an existing to-do, opens it, and removes it", async () => {
  const user = mount(fakeToDos())
  const page = await screen.findByRole("main", { name: "To-dos" })
  const title = within(page).getByRole("textbox", { name: "New to-do" })
  await user.type(title, "Screenshot the dialog{Enter}")
  const open = await within(page).findByRole("list", { name: "Open to-dos" })
  const row = within(open).getByText("Screenshot the dialog")

  await user.click(row)
  await pasteImage(user)

  const opener = await within(open).findByRole("button", {
    name: "Open image 1 of Screenshot the dialog",
  })

  await user.click(opener)
  expect(await screen.findByRole("dialog")).toBeTruthy()
  expect(screen.getByRole("heading", { name: "Image 1" })).toBeTruthy()
  await user.keyboard("{Escape}")

  await user.click(
    within(open).getByRole("button", { name: "Remove image 1 of Screenshot the dialog" }),
  )
  await waitFor(() =>
    expect(
      within(open).queryByRole("button", { name: "Open image 1 of Screenshot the dialog" }),
    ).toBeNull(),
  )
})
