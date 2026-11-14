import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import type { ToDo, ToDoImage, ToDoImageUpload } from "@glass/contracts"
import { cn } from "cn"
import { AsyncResult, Atom } from "effect/reactivity"
import { Exit } from "effect"
import { Pencil, Trash2, X } from "lucide-react"
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useState,
} from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"
import { Backend, useBackendRuntime } from "./backend"
import { ImageViewer, type PreviewImage } from "./ImageViewer"
import { imageFiles, imageSrc, readToDoImages } from "./pastedImages"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf, settledProblem } from "./problems"
import { shortcutLabel } from "./shortcutLabel"
import { submitOnShortcut } from "./submitShortcut"
import {
  changeAtom,
  pendingToggleAtom,
  savedToDosAtom,
  type ToDoChange,
  toDoThumbnailAtom,
  toDosAtom,
} from "./toDoList"

interface ToDoFields {
  readonly title: string
  readonly notes: string
}

interface DraftImage extends ToDoImageUpload {
  readonly key: number
}

interface NewToDo extends ToDoFields {
  readonly images: ReadonlyArray<DraftImage>
}

const emptyToDo: NewToDo = { title: "", notes: "", images: [] }

let nextDraftImage = 0

const newToDoAtom = Atom.make<NewToDo>(emptyToDo).pipe(Atom.keepAlive)

const editAtom = Atom.family((_id: number) =>
  Atom.make<ToDoFields | null>(null).pipe(Atom.keepAlive),
)

const uploadOf = ({
  mediaType,
  data,
  thumbnail,
  thumbnailMediaType,
}: DraftImage): ToDoImageUpload => ({
  mediaType,
  data,
  thumbnail,
  thumbnailMediaType,
})

function useToDoChanges() {
  const change = useAtomValue(changeAtom)
  const save = useAtomSet(changeAtom)
  const pending = change.waiting

  const run = (next: ToDoChange) => {
    if (!pending) save(next)
  }

  return {
    pending,
    problem: settledProblem(change),
    add: (
      title: string,
      notes: string,
      images: ReadonlyArray<ToDoImageUpload>,
      onSaved: () => void,
    ) =>
      run({ save: Backend.use((backend) => backend.AddToDo({ title, notes, images })), onSaved }),
    edit: (id: number, title: string, notes: string, onSaved: () => void) =>
      run({ save: Backend.use((backend) => backend.EditToDo({ id, title, notes })), onSaved }),
    setDone: (toDo: ToDo, done: boolean) =>
      run({
        save: Backend.use((backend) => backend.SetToDoDone({ id: toDo.id, done })),
        toggle: { id: toDo.id, done },
        onSaved: () => {
          toast.add({
            type: "success",
            title: done ? "To-do completed" : "To-do reopened",
            description: toDo.title,
            timeout: 2500,
          })
        },
      }),
    remove: (id: number) => run({ save: Backend.use((backend) => backend.DeleteToDo({ id })) }),
    attach: (id: number, images: ReadonlyArray<ToDoImageUpload>) =>
      run({ save: Backend.use((backend) => backend.AttachToDoImages({ id, images })) }),
    removeImage: (id: number) =>
      run({ save: Backend.use((backend) => backend.RemoveToDoImage({ id })) }),
  }
}

const takePastedImages = (
  event: ClipboardEvent,
  pending: boolean,
  add: (images: ReadonlyArray<ToDoImageUpload>) => void,
) => {
  const files = imageFiles(event.clipboardData)

  if (pending || files.length === 0) return

  event.preventDefault()
  void readToDoImages(files).then((images) => {
    if (images.length > 0) add(images)
  })
}

export function ToDos() {
  const toDos = useAtomValue(toDosAtom)
  const retry = useAtomRefresh(savedToDosAtom)

  return (
    <div className="page-content flex flex-col gap-6 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">To-dos</h1>
      {AsyncResult.builder(toDos)
        .onInitialOrWaiting(() => <output>Loading to-dos…</output>)
        .onFailure((cause) => (
          <ProblemAlert problem={problemOf(cause)} action={{ label: "Retry", run: retry }} />
        ))
        .onSuccess((value) => <ToDoList toDos={value} />)
        .render()}
    </div>
  )
}

function ToDoList(props: { toDos: ReadonlyArray<ToDo> }) {
  const { pending, problem } = useToDoChanges()
  const open = props.toDos.filter((toDo) => !toDo.done)
  const done = props.toDos.filter((toDo) => toDo.done)

  return (
    <section aria-label="To-dos" aria-busy={pending} className="flex flex-col gap-4">
      {open.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing to do.</p>
      ) : (
        <ToDoItems label="Open to-dos" toDos={open} />
      )}
      <AddToDo />
      {problem !== null && <ProblemAlert problem={problem} />}
      {done.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground select-none">
            Done ({done.length})
          </summary>
          <ToDoItems label="Done to-dos" toDos={done} className="mt-2" />
        </details>
      )}
    </section>
  )
}

function ToDoItems(props: { label: string; toDos: ReadonlyArray<ToDo>; className?: string }) {
  return (
    <ul aria-label={props.label} className={cn("divide-y rounded-md border", props.className)}>
      {props.toDos.map((toDo) => (
        <ToDoRow key={toDo.id} toDo={toDo} />
      ))}
    </ul>
  )
}

interface OpenedImage {
  readonly image: PreviewImage
  readonly opener: HTMLElement
}

function LargeImage(props: { opened: OpenedImage | null; onClose: () => void }) {
  const opened = props.opened

  if (opened === null) return null

  return (
    <ImageViewer images={[opened.image]} index={0} opener={opened.opener} onClose={props.onClose} />
  )
}

function ImageStrip(props: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={props.label} className="flex flex-wrap gap-2 pt-2">
      {props.children}
    </ul>
  )
}

function AddToDo() {
  const [draft, setDraft] = useAtom(newToDoAtom)
  const { pending, add } = useToDoChanges()
  const { title, notes, images } = draft
  const trimmed = title.trim()
  const [opened, setOpened] = useState<OpenedImage | null>(null)

  return (
    <Card
      render={
        <form
          aria-label="Add a to-do"
          onPaste={(event) =>
            takePastedImages(event, false, (pasted) =>
              setDraft((current) => ({
                ...current,
                images: [
                  ...current.images,
                  ...pasted.map((image) => ({ ...image, key: ++nextDraftImage })),
                ],
              })),
            )
          }
          onSubmit={(event) => {
            event.preventDefault()

            if (trimmed === "") return

            const submitted = draft
            add(trimmed, notes.trimEnd(), images.map(uploadOf), () =>
              setDraft((typed) => (typed === submitted ? emptyToDo : typed)),
            )
          }}
        />
      }
      className="focus-within:ring-3 focus-within:ring-ring/50"
    >
      <CardContent className="flex flex-col gap-1">
        <Input
          aria-label="New to-do"
          placeholder="Add a to-do"
          value={title}
          onChange={(event) => setDraft({ title: event.target.value, notes, images })}
          className="h-8 border-0 bg-transparent px-0 font-medium shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
        />
        <Textarea
          aria-label="Notes"
          placeholder="Notes"
          value={notes}
          onChange={(event) => setDraft({ title, notes: event.target.value, images })}
          onKeyDown={submitOnShortcut}
          className="min-h-10 resize-none border-0 bg-transparent px-0 py-0 text-sm shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
        />
        {images.length > 0 && (
          <ImageStrip label="Images">
            {images.map((image, index) => (
              <li key={image.key} className="flex items-start gap-0.5">
                <button
                  type="button"
                  aria-label={`Open image ${index + 1}`}
                  className="rounded-md"
                  onClick={(event) =>
                    setOpened({
                      image: {
                        src: imageSrc(image.mediaType, image.data),
                        name: `Image ${index + 1}`,
                      },
                      opener: event.currentTarget,
                    })
                  }
                >
                  <img
                    src={imageSrc(image.thumbnailMediaType, image.thumbnail)}
                    alt=""
                    className="size-14 rounded-md border object-cover"
                  />
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove image ${index + 1}`}
                  onClick={() =>
                    setDraft({
                      title,
                      notes,
                      images: images.filter((kept) => kept.key !== image.key),
                    })
                  }
                >
                  <X aria-hidden />
                </Button>
              </li>
            ))}
          </ImageStrip>
        )}
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <span className="text-xs text-muted-foreground" aria-hidden>
          {shortcutLabel("↵")}
        </span>
        <Button type="submit" size="sm" disabled={pending || trimmed === ""}>
          Add
        </Button>
      </CardFooter>
      <LargeImage opened={opened} onClose={() => setOpened(null)} />
    </Card>
  )
}

function ToDoRow(props: { toDo: ToDo }) {
  const { toDo } = props
  const { pending, setDone, remove, attach } = useToDoChanges()
  const [edit, setEdit] = useAtom(editAtom(toDo.id))
  const toggle = useAtomValue(pendingToggleAtom)
  const checked = toggle?.id === toDo.id ? toggle.done : toDo.done

  const paste = (event: ClipboardEvent) =>
    takePastedImages(event, pending, (images) => attach(toDo.id, images))

  if (edit !== null) {
    return (
      <li className="px-3 py-2">
        <ToDoEditor toDo={toDo} edit={edit} onPaste={paste} />
      </li>
    )
  }

  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <Checkbox
        aria-label={toDo.title}
        className="mt-1"
        checked={checked}
        disabled={pending}
        onCheckedChange={(nextChecked) => setDone(toDo, nextChecked)}
      />
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- The row takes a pasted image once it has focus. */}
      <div
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The row takes a pasted image once it has focus.
        tabIndex={0}
        className="min-w-0 flex-1 py-0.5 outline-none"
        onMouseDown={(event) => {
          if (event.target instanceof Element && event.target.closest("button")) return
          event.currentTarget.focus()
        }}
        onPaste={paste}
      >
        <p className={cn("text-sm break-words", checked && "text-muted-foreground line-through")}>
          {toDo.title}
        </p>
        {toDo.notes !== "" && (
          <p className="mt-1 text-sm break-words whitespace-pre-wrap text-muted-foreground">
            {toDo.notes}
          </p>
        )}
        <SavedImages toDo={toDo} />
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Edit ${toDo.title}`}
        title="Edit"
        disabled={pending}
        onClick={() => setEdit({ title: toDo.title, notes: toDo.notes })}
      >
        <Pencil aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Delete ${toDo.title}`}
        title="Delete"
        disabled={pending}
        onClick={() => remove(toDo.id)}
      >
        <Trash2 aria-hidden />
      </Button>
    </li>
  )
}

const focusOnMount = (element: HTMLInputElement | null) => element?.focus()

function ToDoEditor(props: {
  toDo: ToDo
  edit: ToDoFields
  onPaste: (event: ClipboardEvent) => void
}) {
  const { pending, edit } = useToDoChanges()
  const setEdit = useAtomSet(editAtom(props.toDo.id))
  const { title, notes } = props.edit
  const trimmed = title.trim()
  const close = () => setEdit(null)

  const cancelOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") close()
  }

  return (
    <form
      aria-label={`Edit ${props.toDo.title}`}
      className="flex flex-col gap-2"
      onPaste={props.onPaste}
      onSubmit={(event) => {
        event.preventDefault()

        if (trimmed === "") return

        const submitted = props.edit
        edit(props.toDo.id, trimmed, notes.trimEnd(), () =>
          setEdit((current) => (current === submitted ? null : current)),
        )
      }}
    >
      <Input
        aria-label="Title"
        value={title}
        ref={focusOnMount}
        onChange={(event) => setEdit({ title: event.target.value, notes })}
        onKeyDown={cancelOnEscape}
      />
      <Textarea
        aria-label="Notes"
        placeholder="Notes"
        value={notes}
        onChange={(event) => setEdit({ title, notes: event.target.value })}
        onKeyDown={cancelOnEscape}
      />
      <SavedImages toDo={props.toDo} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending || trimmed === ""}>
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={close}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function useWhenVisible() {
  const [visible, setVisible] = useState(globalThis.IntersectionObserver === undefined)

  const setElement = useCallback(
    (element: HTMLElement | null) => {
      if (element === null || visible || globalThis.IntersectionObserver === undefined) {
        return undefined
      }

      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true)
      })

      observer.observe(element)

      return () => observer.disconnect()
    },
    [visible],
  )

  return { setElement, visible }
}

function SavedImages(props: { toDo: ToDo }) {
  const { removeImage, pending } = useToDoChanges()

  if (props.toDo.images.length === 0) return null

  return (
    <ImageStrip label={`Images of ${props.toDo.title}`}>
      {props.toDo.images.map((image, index) => (
        <SavedImage
          key={image.id}
          image={image}
          title={props.toDo.title}
          index={index}
          pending={pending}
          onRemove={() => removeImage(image.id)}
        />
      ))}
    </ImageStrip>
  )
}

function SavedImage(props: {
  image: ToDoImage
  title: string
  index: number
  pending: boolean
  onRemove: () => void
}) {
  const { setElement, visible } = useWhenVisible()
  const runtime = useBackendRuntime()
  const [opened, setOpened] = useState<OpenedImage | null>(null)
  const number = props.index + 1

  const open = (opener: HTMLButtonElement) => {
    void runtime
      .runPromiseExit(
        Backend.use((backend) => backend.ReadToDoImage({ id: props.image.id, size: "full" })),
      )
      .then((exit) => {
        if (Exit.isSuccess(exit)) {
          setOpened({
            image: {
              src: imageSrc(exit.value.mediaType, exit.value.data),
              name: `Image ${number}`,
            },
            opener,
          })

          return
        }

        toast.add({ type: "error", title: "Couldn't open that image" })
      })
  }

  return (
    <li className="flex items-start gap-0.5">
      <button
        type="button"
        ref={setElement}
        aria-label={`Open image ${number} of ${props.title}`}
        className="rounded-md"
        onClick={(event) => open(event.currentTarget)}
      >
        {visible ? (
          <ToDoThumbnail id={props.image.id} />
        ) : (
          <span className="block size-14 rounded-md border bg-muted" />
        )}
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove image ${number} of ${props.title}`}
        disabled={props.pending}
        onClick={props.onRemove}
      >
        <X aria-hidden />
      </Button>
      <LargeImage opened={opened} onClose={() => setOpened(null)} />
    </li>
  )
}

function ToDoThumbnail(props: { id: number }) {
  const result = useAtomValue(toDoThumbnailAtom(props.id))

  return AsyncResult.builder(result)
    .onInitialOrWaiting(() => <span className="block size-14 rounded-md border bg-muted" />)
    .onFailure(() => <span className="block size-14 rounded-md border bg-muted" />)
    .onSuccess((image) => (
      <img
        src={imageSrc(image.mediaType, image.data)}
        alt=""
        loading="lazy"
        decoding="async"
        className="size-14 rounded-md border object-cover"
      />
    ))
    .render()
}
